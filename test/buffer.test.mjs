import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBufferClient, BufferError } from '../netlify/functions/lib/buffer.mjs';

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const r = responses.shift();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers || {} });
  };
  return { fn, calls };
}

test('createDraft sends the hosted image with alt text and returns the content item id', async () => {
  const f = fakeFetch([{
    status: 200,
    body: { data: { createContentItemDraft: { __typename: 'CreateContentItemDraftSuccess', contentItem: { id: 'ci_9' } } } },
  }]);
  const client = createBufferClient({ apiKey: 'k', fetchImpl: f.fn });
  const draft = await client.createDraft({
    organizationId: 'org_1',
    text: 'Best night',
    imageUrl: 'https://afterglow.test/media/a.jpg',
    altText: 'Photo from Reiji',
    correlationId: 'corr-1',
  });

  assert.equal(draft.id, 'ci_9');
  assert.equal(f.calls[0].headers.Authorization, 'Bearer k');
  const input = f.calls[0].body.variables.input;
  assert.equal(input.organizationId, 'org_1');
  assert.equal(input.correlationId, 'corr-1');
  assert.equal(input.draft.text, 'Best night');
  assert.deepEqual(input.draft.assets[0], {
    image: { url: 'https://afterglow.test/media/a.jpg', metadata: { altText: 'Photo from Reiji' } },
  });
});

test('a failure payload becomes a BufferError carrying Buffer\'s message', async () => {
  const f = fakeFetch([{
    status: 200,
    body: { data: { createContentItemDraft: { __typename: 'InvalidInputError', message: 'bad image' } } },
  }]);
  const client = createBufferClient({ apiKey: 'k', fetchImpl: f.fn });
  await assert.rejects(
    () => client.createDraft({ organizationId: 'o', imageUrl: 'https://x/y.jpg', altText: 'a' }),
    (err) => err instanceof BufferError && /bad image/.test(err.message),
  );
});

test('429 surfaces retryAfter from the error body', async () => {
  const f = fakeFetch([{
    status: 429,
    body: { errors: [{ message: 'Too many', extensions: { code: 'RATE_LIMIT_EXCEEDED', retryAfter: 900 } }] },
  }]);
  const client = createBufferClient({ apiKey: 'k', fetchImpl: f.fn });
  await assert.rejects(
    () => client.organizations(),
    (err) => err.status === 429 && err.retryAfter === 900,
  );
});

test('promote sends a custom-scheduled automatic post with the same image', async () => {
  const f = fakeFetch([{
    status: 200,
    body: { data: { promoteContentItemDraftToPosts: { __typename: 'PromoteContentItemDraftToPostsSuccess', contentItem: { id: 'ci_9' } } } },
  }]);
  const client = createBufferClient({ apiKey: 'k', fetchImpl: f.fn });
  await client.promote({
    contentItemId: 'ci_9',
    channelId: 'ch_1',
    text: 'Best night',
    imageUrl: 'https://afterglow.test/media/a.jpg',
    altText: 'Alt',
    dueAt: '2026-11-02T18:00:00.000Z',
  });
  const post = f.calls[0].body.variables.input.posts[0];
  assert.equal(f.calls[0].body.variables.input.id, 'ci_9');
  assert.equal(post.channelId, 'ch_1');
  assert.equal(post.mode, 'customScheduled');
  assert.equal(post.schedulingType, 'automatic');
  assert.equal(post.dueAt, '2026-11-02T18:00:00.000Z');
  assert.equal(post.assets[0].image.url, 'https://afterglow.test/media/a.jpg');
});
