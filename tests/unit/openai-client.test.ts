import { describe, expect, it } from 'vitest';
import { LlmError, OpenAiClient } from '../../apps/api/src/agent/llm';

const ok = (message: unknown) => new Response(JSON.stringify({ model: 'm-1', choices: [{ message }], usage: { prompt_tokens: 11, completion_tokens: 4 } }), { status: 200 });
const mk = (responses: Array<Response | Error>, over: Record<string, unknown> = {}) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('no more responses');
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const client = new OpenAiClient({ apiKey: 'sk-secret', model: 'm-1', fetch: f, sleep: async (ms) => void sleeps.push(ms), ...over });
  return { client, calls, sleeps };
};
const req = { messages: [{ role: 'system' as const, content: 's' }, { role: 'user' as const, content: 'hi' }], tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }] };

describe('OpenAiClient', () => {
  it('sends model, messages and tools; parses content, tool calls and usage', async () => {
    const { client, calls } = mk([ok({ content: ' привіт ', tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{"a":1}' } }] })]);
    const r = await client.complete({
      ...req,
      messages: [...req.messages, { role: 'assistant', content: null, toolCalls: [{ id: 'c0', name: 't', arguments: '{}' }] }, { role: 'tool', toolCallId: 'c0', content: '{}' }],
    });
    expect(r).toEqual({ content: 'привіт', toolCalls: [{ id: 'c1', name: 't', arguments: '{"a":1}' }], model: 'm-1', inputTokens: 11, outputTokens: 4 });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-secret');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe('m-1');
    expect(body.tools).toEqual([{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }]);
    expect(body.messages[2]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 't', arguments: '{}' } }] });
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c0', content: '{}' });
    expect(JSON.stringify(body)).not.toContain('sk-secret');
  });
  it('retries 429 and 5xx with backoff, then succeeds', async () => {
    const { client, calls, sleeps } = mk([new Response('x', { status: 429 }), new Response('x', { status: 503 }), ok({ content: 'ok' })]);
    expect((await client.complete(req)).content).toBe('ok');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });
  it('does not retry a 400/401 and does not leak the response body or key into the error', async () => {
    const { client, calls } = mk([new Response('{"error":"your prompt: секрет"}', { status: 401 })]);
    const e = await client.complete(req).catch((x) => x);
    expect(e).toBeInstanceOf(LlmError);
    expect(e).toMatchObject({ status: 401, retryable: false, message: 'OpenAI HTTP 401' });
    expect(calls).toHaveLength(1);
    expect(String(e.message)).not.toContain('секрет');
  });
  it('gives up after the attempt limit and treats network errors as retryable', async () => {
    const { client, calls } = mk([new TypeError('fetch failed'), new TypeError('fetch failed')], { attempts: 2 });
    const e = await client.complete(req).catch((x) => x);
    expect(e).toMatchObject({ retryable: true });
    expect(calls).toHaveLength(2);
  });
  it('fails on a response without a message', async () => {
    const { client } = mk([new Response('{"choices":[]}', { status: 200 })]);
    await expect(client.complete(req)).rejects.toMatchObject({ retryable: false });
  });
});
