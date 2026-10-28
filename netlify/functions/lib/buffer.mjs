import { randomUUID } from 'node:crypto';

// Thin client for Buffer's GraphQL API (experimental content-item surface).
// Field names follow Buffer's published reference as of Oct 2026. Verify against the
// live schema on first run: the API is marked experimental and can change.

const DEFAULT_ENDPOINT = 'https://api.buffer.com';

export class BufferError extends Error {
  constructor(message, { status = 502, retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const ORGANIZATIONS_QUERY = `query { account { organizations { id name } } }`;

const CHANNELS_QUERY = `query Channels($input: ChannelsInput!) {
  channels(input: $input) { id name displayName }
}`;

const DRAFT_MUTATION = `mutation CreateDraft($input: CreateContentItemDraftInput!) {
  createContentItemDraft(input: $input) {
    __typename
    ... on CreateContentItemDraftSuccess { contentItem { id } }
    ... on MutationError { message }
  }
}`;

const PROMOTE_MUTATION = `mutation Promote($input: PromoteContentItemDraftToPostsInput!) {
  promoteContentItemDraftToPosts(input: $input) {
    __typename
    ... on PromoteContentItemDraftToPostsSuccess { contentItem { id } }
    ... on MutationError { message }
  }
}`;

const imageAsset = (url, altText) => ({ image: { url, metadata: { altText } } });

export function createBufferClient({ apiKey, endpoint = DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error('apiKey is required');

  async function gql(query, variables) {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));

    if (res.status === 429) {
      const retry = body?.errors?.[0]?.extensions?.retryAfter ?? res.headers.get('retry-after');
      throw new BufferError('Buffer rate limit reached', {
        status: 429,
        retryAfter: retry == null ? null : Number(retry),
      });
    }
    if (!res.ok || body.errors?.length) {
      throw new BufferError(
        body.errors?.map((e) => e.message).join('; ') || `Buffer HTTP ${res.status}`,
        { status: 502 },
      );
    }
    return body.data;
  }

  return {
    async organizations() {
      const data = await gql(ORGANIZATIONS_QUERY);
      return data.account.organizations;
    },

    async channels(organizationId) {
      const data = await gql(CHANNELS_QUERY, { input: { organizationId } });
      return data.channels;
    },

    // Creates a channel-less draft with one hosted image. Returns { id }.
    async createDraft({ organizationId, text = '', imageUrl, altText, title, correlationId = randomUUID() }) {
      const input = {
        organizationId,
        correlationId,
        draft: { text, assets: [imageAsset(imageUrl, altText)] },
      };
      if (title) input.title = title;

      const data = await gql(DRAFT_MUTATION, { input });
      const result = data?.createContentItemDraft;
      if (!result?.contentItem?.id) {
        throw new BufferError(result?.message || `Draft failed (${result?.__typename ?? 'no response'})`, { status: 422 });
      }
      return { id: result.contentItem.id };
    },

    // Turns a draft into a scheduled channel post. One-way: the draft can't be edited afterward.
    async promote({ contentItemId, channelId, text = '', imageUrl, altText, dueAt }) {
      const input = {
        id: contentItemId,
        posts: [{
          channelId,
          text,
          assets: [imageAsset(imageUrl, altText)],
          mode: 'customScheduled',
          dueAt,
          schedulingType: 'automatic',
        }],
      };

      const data = await gql(PROMOTE_MUTATION, { input });
      const result = data?.promoteContentItemDraftToPosts;
      if (!result?.contentItem?.id) {
        throw new BufferError(result?.message || `Promote failed (${result?.__typename ?? 'no response'})`, { status: 422 });
      }
      return { id: result.contentItem.id };
    },
  };
}
