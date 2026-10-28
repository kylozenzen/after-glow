import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../netlify/functions/lib/app.mjs';

// In-memory stand-in for Netlify Blobs (getStore). Same method names.
function memStore() {
  const m = new Map();
  return {
    async get(key, { type } = {}) {
      if (!m.has(key)) return undefined;
      const v = m.get(key);
      if (type === 'json') return JSON.parse(v);
      return v;
    },
    async setJSON(key, value) { m.set(key, JSON.stringify(value)); },
    async set(key, data) { m.set(key, data); },
    async delete(key) { m.delete(key); },
    async list() { return { blobs: [...m.keys()].map((key) => ({ key })) }; },
  };
}

const OWNER = 'test-owner';
const BASE = 'https://afterglow.test';

function makeApp(buffer = null) {
  return createHandler({
    stores: { events: memStore(), uploads: memStore(), photos: memStore() },
    ownerToken: OWNER,
    publicBaseUrl: BASE,
    buffer,
    organizationId: 'org-1',
  });
}

function seg(marker, payload) {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function jpegWithGps() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0')),
    seg(0xe1, Buffer.from('Exif\0\0GPS-SECRET')),
    seg(0xdb, Buffer.from([0, 1, 2, 3])),
    seg(0xda, Buffer.from([0, 1, 0, 0, 0, 0])),
    Buffer.from('SCAN'),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const call = (app, method, path, { body, headers = {} } = {}) =>
  app(new Request(`${BASE}${path}`, { method, body, headers }));

const owner = { 'x-owner-token': OWNER };

async function createEvent(app) {
  const res = await call(app, 'POST', '/api/events', {
    headers: { ...owner, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Twilight Night', venue: 'Reiji', spots: ['Bar', 'Wall'] }),
  });
  return res.json();
}

async function upload(app, eventId, { spot = 'Bar', consent = 'true', hasMinors = 'false', bytes = jpegWithGps() } = {}) {
  const qs = new URLSearchParams({ spot, consent, hasMinors, caption: 'Great night' });
  return call(app, 'POST', `/api/events/${eventId}/uploads?${qs}`, {
    body: bytes,
    headers: { 'Content-Type': 'image/jpeg' },
  });
}

test('owner endpoints refuse without the token', async () => {
  const app = makeApp();
  const res = await call(app, 'GET', '/api/events');
  assert.equal(res.status, 401);
});

test('create event, then fetch public details without the token', async () => {
  const app = makeApp();
  const e = await createEvent(app);
  const pub = await (await call(app, 'GET', `/api/events/${e.id}`)).json();
  assert.equal(pub.name, 'Twilight Night');
  assert.deepEqual(pub.spots, ['Bar', 'Wall']);
  assert.equal(pub.createdAt, undefined);
});

test('upload needs permission and a listed spot', async () => {
  const app = makeApp();
  const e = await createEvent(app);
  assert.equal((await upload(app, e.id, { consent: 'false' })).status, 400);
  assert.equal((await upload(app, e.id, { spot: 'Nowhere' })).status, 400);
});

test('upload rejects non-image bytes', async () => {
  const app = makeApp();
  const e = await createEvent(app);
  const res = await upload(app, e.id, { bytes: Buffer.from('not a photo') });
  assert.equal(res.status, 415);
});

test('pending photo is hidden from the public until approved, and GPS is stripped', async () => {
  const app = makeApp();
  const e = await createEvent(app);
  const up = await (await upload(app, e.id)).json();
  assert.equal(up.status, 'pending');

  assert.equal((await call(app, 'GET', `/media/${up.id}.jpg`)).status, 404);

  const list = await (await call(app, 'GET', `/api/events/${e.id}/uploads`, { headers: owner })).json();
  const file = list.uploads[0].file;
  const stored = await (await call(app, 'GET', `/api/uploads/${up.id}/file`, { headers: owner })).arrayBuffer();
  assert.equal(Buffer.from(stored).includes('GPS-SECRET'), false);

  await call(app, 'PATCH', `/api/uploads/${up.id}`, {
    headers: { ...owner, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  });
  const pub = await call(app, 'GET', `/media/${file}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('Content-Type'), 'image/jpeg');
});

test('kids photo is held, and approval is blocked until guardian consent', async () => {
  const app = makeApp();
  const e = await createEvent(app);
  const up = await (await upload(app, e.id, { hasMinors: 'true' })).json();
  assert.equal(up.status, 'held');

  const patch = (body) => call(app, 'PATCH', `/api/uploads/${up.id}`, {
    headers: { ...owner, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal((await patch({ status: 'approved' })).status, 409);
  const consent = await (await patch({ guardianConsent: true })).json();
  assert.equal(consent.status, 'pending');
  assert.equal((await patch({ status: 'approved' })).status, 200);
});

test('send without Buffer key is a dry run that shows the draft payload', async () => {
  const app = makeApp(null);
  const e = await createEvent(app);
  const up = await (await upload(app, e.id)).json();
  await call(app, 'PATCH', `/api/uploads/${up.id}`, {
    headers: { ...owner, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  });
  const res = await call(app, 'POST', `/api/uploads/${up.id}/send`, { headers: owner });
  const body = await res.json();
  assert.equal(body.dryRun, true);
  assert.match(body.draft.imageUrl, /^https:\/\/afterglow\.test\/media\/.+\.jpg$/);
  assert.match(body.draft.altText, /Reiji/);
});

test('send with a fake Buffer creates a draft then schedules it', async () => {
  const calls = [];
  const buffer = {
    organizations: async () => [{ id: 'org-1', name: 'Test' }],
    channels: async () => [],
    createDraft: async (args) => { calls.push(['draft', args]); return { id: 'draft-9' }; },
    promote: async (args) => { calls.push(['promote', args]); return {}; },
  };
  const app = makeApp(buffer);
  const e = await createEvent(app);
  const up = await (await upload(app, e.id)).json();
  await call(app, 'PATCH', `/api/uploads/${up.id}`, {
    headers: { ...owner, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  });
  const due = new Date(Date.now() + 86400000).toISOString();
  const res = await call(app, 'POST', `/api/uploads/${up.id}/send`, {
    headers: { ...owner, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: 'chan-1', dueAt: due }),
  });
  assert.equal(res.status, 200);
  assert.equal(calls[0][0], 'draft');
  assert.equal(calls[0][1].organizationId, 'org-1');
  assert.match(calls[0][1].altText, /Reiji/);
  assert.equal(calls[1][0], 'promote');
  assert.equal(calls[1][1].contentItemId, 'draft-9');
  const after = await res.json();
  assert.equal(after.status, 'scheduled');
});

test('retire removes the photo from public access', async () => {
  const app = makeApp();
  const e = await createEvent(app);
  const up = await (await upload(app, e.id)).json();
  await call(app, 'PATCH', `/api/uploads/${up.id}`, {
    headers: { ...owner, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  });
  const list = await (await call(app, 'GET', `/api/events/${e.id}/uploads`, { headers: owner })).json();
  const file = list.uploads[0].file;
  assert.equal((await call(app, 'GET', `/media/${file}`)).status, 200);
  const r = await call(app, 'POST', `/api/uploads/${up.id}/retire`, { headers: owner });
  assert.equal(r.status, 200);
  assert.equal((await call(app, 'GET', `/media/${file}`)).status, 404);
});
