import { randomUUID } from 'node:crypto';
import { detectType, stripMetadata } from './exif.mjs';
import { BufferError } from './buffer.mjs';

// Netlify sync functions accept request bodies up to about 6 MB.
const MAX_BYTES = 6 * 1024 * 1024;
const LIVE = new Set(['approved', 'sent', 'scheduled', 'published']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

async function readJson(req) {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// stores: { events, uploads, photos } with Netlify Blobs-style methods
// get(key, { type }), setJSON(key, value), set(key, data), delete(key), list()
export function createHandler({ stores, ownerToken = '', publicBaseUrl = '', buffer = null, organizationId = '' }) {
  const base = publicBaseUrl.replace(/\/$/, '');
  let orgId = organizationId;

  const requireOwner = (req) => {
    if (!ownerToken || req.headers.get('x-owner-token') !== ownerToken) {
      throw new HttpError(401, 'Owner token required');
    }
  };
  const getEvent = async (id) => {
    const e = await stores.events.get(id, { type: 'json' });
    if (!e) throw new HttpError(404, 'Event not found');
    return e;
  };
  const getUpload = async (id) => {
    const u = await stores.uploads.get(id, { type: 'json' });
    if (!u) throw new HttpError(404, 'Upload not found');
    return u;
  };
  const listUploads = async () => {
    const { blobs } = await stores.uploads.list();
    const all = await Promise.all(blobs.map((b) => stores.uploads.get(b.key, { type: 'json' })));
    return all.filter(Boolean);
  };
  const saveUpload = (u) => stores.uploads.setJSON(u.id, u);
  const mediaUrl = (file) => `${base}/media/${file}`;
  const altFor = (u, e) => u.altText || `Photo from ${e.venue}, ${e.name}`;
  const draftFields = (u, e) => ({ text: u.caption, imageUrl: mediaUrl(u.file), altText: altFor(u, e) });

  async function resolveOrg() {
    if (orgId) return orgId;
    const orgs = await buffer.organizations();
    if (orgs.length !== 1) throw new HttpError(500, `Set BUFFER_ORG_ID: this account has ${orgs.length} organizations`);
    orgId = orgs[0].id;
    return orgId;
  }

  async function createUpload(req, eventId, url) {
    const e = await getEvent(eventId);
    const spot = url.searchParams.get('spot') || '';
    if (!e.spots.includes(spot)) throw new HttpError(400, 'Pick a spot from the list');
    if (url.searchParams.get('consent') !== 'true') throw new HttpError(400, 'Photo permission is required');

    const hasMinors = url.searchParams.get('hasMinors') === 'true';
    const caption = (url.searchParams.get('caption') || '').slice(0, 280);
    const raw = Buffer.from(await req.arrayBuffer());
    if (raw.length > MAX_BYTES) throw new HttpError(413, 'Photo too large (6 MB max)');

    const type = detectType(raw);
    if (!type) throw new HttpError(415, 'Only JPEG or PNG photos');
    let clean;
    try {
      clean = stripMetadata(raw, type);
    } catch {
      throw new HttpError(415, 'Could not read that photo');
    }

    const id = randomUUID();
    const file = `${id}.${type === 'image/png' ? 'png' : 'jpg'}`;
    await stores.photos.set(file, toArrayBuffer(clean), { metadata: { contentType: type } });

    const u = {
      id,
      eventId,
      spot,
      caption,
      altText: '',
      hasMinors,
      guardianConsent: false,
      status: hasMinors ? 'held' : 'pending',
      file,
      contentType: type,
      createdAt: new Date().toISOString(),
      bufferContentItemId: null,
      scheduledAt: null,
    };
    await saveUpload(u);
    return json({ id, status: u.status }, 201);
  }

  async function updateUpload(req, id) {
    const u = await getUpload(id);
    const b = await readJson(req);

    if (typeof b.caption === 'string') u.caption = b.caption.slice(0, 280);
    if (typeof b.altText === 'string') u.altText = b.altText.slice(0, 1000);

    if (typeof b.guardianConsent === 'boolean') {
      if (!b.guardianConsent && ['sent', 'scheduled', 'published'].includes(u.status)) {
        throw new HttpError(409, 'Already sent to Buffer');
      }
      u.guardianConsent = b.guardianConsent;
      if (u.hasMinors) {
        if (b.guardianConsent && u.status === 'held') u.status = 'pending';
        if (!b.guardianConsent && ['pending', 'approved'].includes(u.status)) u.status = 'held';
      }
    }

    if (b.status !== undefined) {
      if (b.status === 'approved') {
        if (u.status === 'held') throw new HttpError(409, 'Held until guardian consent is recorded');
        if (!['pending', 'rejected'].includes(u.status)) throw new HttpError(409, `Cannot approve a ${u.status} photo`);
        u.status = 'approved';
      } else if (b.status === 'rejected') {
        if (!['pending', 'approved', 'held'].includes(u.status)) throw new HttpError(409, `Cannot reject a ${u.status} photo`);
        u.status = 'rejected';
      } else {
        throw new HttpError(400, 'status must be approved or rejected');
      }
    }

    await saveUpload(u);
    return json(u);
  }

  async function sendUpload(req, id) {
    const u = await getUpload(id);
    const e = await getEvent(u.eventId);
    const b = await readJson(req);

    const channelId = b.channelId ? String(b.channelId) : null;
    const dueAt = b.dueAt ? new Date(b.dueAt) : null;
    if (dueAt && Number.isNaN(dueAt.getTime())) throw new HttpError(400, 'Bad dueAt');
    if (dueAt && dueAt.getTime() <= Date.now()) throw new HttpError(400, 'dueAt must be in the future');
    if (dueAt && !channelId) throw new HttpError(400, 'Pick a channel to schedule');

    const canDraft = u.status === 'approved';
    const canSchedule = u.status === 'sent' && dueAt;
    if (!canDraft && !canSchedule) {
      throw new HttpError(409, `Cannot send a ${u.status} photo${u.status === 'sent' ? ' without a time' : ''}`);
    }
    if (!base) throw new HttpError(500, 'PUBLIC_BASE_URL is not set; Buffer cannot fetch images');

    const fields = draftFields(u, e);
    if (!buffer) {
      return json({ dryRun: true, draft: fields, promote: dueAt ? { channelId, dueAt: dueAt.toISOString() } : null });
    }

    const organizationId = await resolveOrg();
    if (canDraft) {
      const draft = await buffer.createDraft({ organizationId, title: e.name, correlationId: u.id, ...fields });
      u.bufferContentItemId = draft.id;
      u.status = 'sent';
      await saveUpload(u);
    }
    if (dueAt) {
      await buffer.promote({ contentItemId: u.bufferContentItemId, channelId, dueAt: dueAt.toISOString(), ...fields });
      u.status = 'scheduled';
      u.scheduledAt = dueAt.toISOString();
      await saveUpload(u);
    }
    return json(u);
  }

  async function retireUpload(id) {
    const u = await getUpload(id);
    if (u.status === 'retired') throw new HttpError(409, 'Already retired');
    await stores.photos.delete(u.file);
    u.status = 'retired';
    await saveUpload(u);
    return json(u);
  }

  async function handle(req, url) {
    const p = url.pathname;
    const m = req.method;
    let match;

    // Public photo link. Only live photos are served, so Buffer can fetch them and nothing else.
    const mi = p.lastIndexOf('/media/');
    if (m === 'GET' && mi >= 0) {
      const file = p.slice(mi + '/media/'.length);
      const u = (await listUploads()).find((x) => x.file === file);
      if (!u || !LIVE.has(u.status)) throw new HttpError(404, 'Not found');
      const data = await stores.photos.get(file, { type: 'arrayBuffer' });
      if (!data) throw new HttpError(404, 'Not found');
      return new Response(data, {
        headers: { 'Content-Type': u.contentType, 'Cache-Control': 'public, max-age=3600' },
      });
    }

    const ai = p.indexOf('/api/');
    if (ai < 0) throw new HttpError(404, 'Not found');
    const ap = p.slice(ai);

    if (m === 'GET' && ap === '/api/channels') {
      requireOwner(req);
      if (!buffer) return json({ channels: [], dryRun: true });
      return json({ channels: await buffer.channels(await resolveOrg()) });
    }

    if (ap === '/api/events' && m === 'GET') {
      requireOwner(req);
      const { blobs } = await stores.events.list();
      const events = (await Promise.all(blobs.map((x) => stores.events.get(x.key, { type: 'json' })))).filter(Boolean);
      return json({ events });
    }

    if (ap === '/api/events' && m === 'POST') {
      requireOwner(req);
      const b = await readJson(req);
      const name = String(b.name || '').trim();
      if (!name) throw new HttpError(400, 'Event name is required');
      const spots = Array.isArray(b.spots) && b.spots.length
        ? b.spots.map((s) => String(s).trim()).filter(Boolean)
        : ['Main bar', 'Photo wall', 'Patio'];
      const id = randomUUID();
      const e = { id, name, venue: String(b.venue || '').trim(), spots, createdAt: new Date().toISOString() };
      await stores.events.setJSON(id, e);
      return json(e, 201);
    }

    if (m === 'GET' && (match = ap.match(/^\/api\/events\/([^/]+)$/))) {
      const e = await getEvent(match[1]);
      return json({ id: e.id, name: e.name, venue: e.venue, spots: e.spots });
    }

    if (m === 'GET' && (match = ap.match(/^\/api\/events\/([^/]+)\/uploads$/))) {
      requireOwner(req);
      await getEvent(match[1]);
      const uploads = (await listUploads())
        .filter((u) => u.eventId === match[1])
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return json({ uploads });
    }

    if (m === 'POST' && (match = ap.match(/^\/api\/events\/([^/]+)\/uploads$/))) {
      return createUpload(req, match[1], url);
    }

    if (m === 'GET' && (match = ap.match(/^\/api\/uploads\/([^/]+)\/file$/))) {
      requireOwner(req);
      const u = await getUpload(match[1]);
      const data = await stores.photos.get(u.file, { type: 'arrayBuffer' });
      if (!data) throw new HttpError(404, 'File removed');
      return new Response(data, { headers: { 'Content-Type': u.contentType, 'Cache-Control': 'private, no-store' } });
    }

    if (m === 'PATCH' && (match = ap.match(/^\/api\/uploads\/([^/]+)$/))) {
      requireOwner(req);
      return updateUpload(req, match[1]);
    }

    if (m === 'POST' && (match = ap.match(/^\/api\/uploads\/([^/]+)\/send$/))) {
      requireOwner(req);
      return sendUpload(req, match[1]);
    }

    if (m === 'POST' && (match = ap.match(/^\/api\/uploads\/([^/]+)\/retire$/))) {
      requireOwner(req);
      return retireUpload(match[1]);
    }

    throw new HttpError(404, 'Not found');
  }

  return async function handler(req) {
    try {
      return await handle(req, new URL(req.url));
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      if (err instanceof BufferError) {
        const body = { error: err.message };
        if (err.retryAfter != null) body.retryAfter = err.retryAfter;
        return json(body, err.status === 429 ? 429 : 502);
      }
      console.error(err);
      return json({ error: 'Server error' }, 500);
    }
  };
}
