import { describe, expect, it } from 'vitest';
import { GraphError, InstagramGraph } from '../../apps/api/src/services/instagram-graph';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const makeGraph = (responses: Response[]) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected Graph call');
    return response;
  }) as typeof fetch;
  const graph = new InstagramGraph(
    {
      appId: 'app-id',
      appSecret: 'app-secret',
      configId: 'config-id',
      apiVersion: 'v26.0',
      graphBaseUrl: 'https://graph.facebook.com',
      authorizeUrl: 'https://www.facebook.com/dialog/oauth',
    },
    fetchImpl,
  );
  return { graph, calls };
};

describe('Instagram Graph webhook subscription', () => {
  it('requires explicit provider acknowledgement', async () => {
    const { graph, calls } = makeGraph([json({ success: true })]);
    await expect(graph.subscribe('secret-token', '17841400000000001')).resolves.toBeUndefined();
    expect(calls[0]!.init.method).toBe('POST');
    expect(new URL(calls[0]!.url).searchParams.get('subscribed_fields')).toBe('messages');
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer secret-token');
  });

  it.each([false, { success: false }, {}, null, { success: 'true' }])('rejects a 200 response without successful subscription: %j', async (body) => {
    const { graph } = makeGraph([json(body)]);
    await expect(graph.subscribe('secret-token', 'account')).rejects.toMatchObject({ kind: 'rejected', status: 200 });
  });

  it('rejects non-JSON success responses', async () => {
    const { graph } = makeGraph([new Response('upstream proxy response')]);
    await expect(graph.subscribe('secret-token', 'account')).rejects.toBeInstanceOf(GraphError);
  });

  it('preserves safe Graph error codes even inside a 200 response', async () => {
    const { graph } = makeGraph([json({ success: true, error: { code: 190, error_subcode: 463, message: 'secret-token' } })]);
    const error = await graph.subscribe('secret-token', 'account').catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'auth', status: 200, graphCode: 190, graphSubcode: 463 });
    expect(String(error)).not.toContain('secret-token');
  });
});

describe('Instagram Graph account selection', () => {
  it('includes another shared account on a later page without trusting its URL', async () => {
    const { graph, calls } = makeGraph([
      json({ data: [{ id: 'one', username: 'first' }], paging: { next: 'https://untrusted.example/?access_token=secret-token', cursors: { after: 'cursor+/=' } } }),
      json({ data: [{ id: 'two', username: 'second' }], paging: { next: 'https://graph.facebook.com/more', cursors: { after: 'unused' } } }),
    ]);
    await expect(graph.assignedAccounts('secret-token')).resolves.toEqual([
      { userId: 'one', username: 'first' },
      { userId: 'two', username: 'second' },
    ]);
    expect(calls).toHaveLength(2);
    const next = new URL(calls[1]!.url);
    expect(next.origin).toBe('https://graph.facebook.com');
    expect(next.pathname).toBe('/v26.0/me/assigned_instagram_accounts');
    expect(next.searchParams.get('after')).toBe('cursor+/=');
    expect(next.searchParams.has('access_token')).toBe(false);
  });

  it('continues through an empty page and counts a duplicated account only once', async () => {
    const { graph } = makeGraph([
      json({ data: [{ id: 'one' }], paging: { next: 'next', cursors: { after: 'first' } } }),
      json({ data: [], paging: { next: 'next', cursors: { after: 'second' } } }),
      json({ data: [{ id: 'one' }] }),
    ]);
    await expect(graph.assignedAccounts('token')).resolves.toEqual([{ userId: 'one', username: null }]);
  });

  it.each([{ next: 'next' }, { next: 'next', cursors: { after: '' } }])('refuses incomplete pagination instead of selecting from a partial list', async (paging) => {
    const { graph } = makeGraph([json({ data: [{ id: 'one' }], paging })]);
    await expect(graph.assignedAccounts('token')).rejects.toBeInstanceOf(GraphError);
  });

  it('refuses cyclic pagination', async () => {
    const page = { data: [{ id: 'one' }], paging: { next: 'next', cursors: { after: 'same' } } };
    const { graph, calls } = makeGraph([json(page), json(page)]);
    await expect(graph.assignedAccounts('token')).rejects.toBeInstanceOf(GraphError);
    expect(calls).toHaveLength(2);
  });

  it.each([{}, { data: [{ id: 'one' }, {}] }, { data: [{ id: 'one' }, { id: 17841400000000001 }] }])(
    'refuses malformed account lists instead of silently discarding assets',
    async (body) => {
      const { graph } = makeGraph([json(body)]);
      await expect(graph.assignedAccounts('token')).rejects.toBeInstanceOf(GraphError);
    },
  );
});
