import { getStore } from '@netlify/blobs';
import { createHandler } from './lib/app.mjs';
import { createBufferClient } from './lib/buffer.mjs';

// Set these in Netlify: Site configuration -> Environment variables.
//   OWNER_TOKEN     required; the password for the owner page
//   BUFFER_API_KEY  optional; without it, sends are dry runs
//   BUFFER_ORG_ID   optional; only needed if the Buffer account has several organizations
// PUBLIC_BASE_URL defaults to the site's own URL (Netlify sets URL automatically).

const buffer = process.env.BUFFER_API_KEY
  ? createBufferClient({ apiKey: process.env.BUFFER_API_KEY })
  : null;

const handler = createHandler({
  stores: {
    events: getStore('afterglow-events'),
    uploads: getStore('afterglow-uploads'),
    photos: getStore('afterglow-photos'),
  },
  ownerToken: process.env.OWNER_TOKEN || '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.URL || '',
  buffer,
  organizationId: process.env.BUFFER_ORG_ID || '',
});

export default async (req) => handler(req);
