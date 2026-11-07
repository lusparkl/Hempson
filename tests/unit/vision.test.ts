import { describe, expect, it, vi } from 'vitest';
import { LlmError } from '../../apps/api/src/agent/llm';
import { DESCRIBE_PROMPT, OpenAiVision, cosine, normalize } from '../../apps/api/src/agent/vision';
import { imageMime } from '../../apps/api/src/services/photo-search';

const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

describe('OpenAI vision client (P9)', () => {
  it('describes a URL or downloaded bytes with one fixed low-detail prompt, and embeds with shortened vectors', async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      return url.endsWith('/embeddings')
        ? ok({ data: [{ embedding: [3, 4] }] })
        : ok({ choices: [{ message: { content: ' red dress ' } }], usage: { prompt_tokens: 90, completion_tokens: 6 } });
    });
    const v = new OpenAiVision({ apiKey: 'sk-test', model: 'gpt-x', embeddingModel: 'text-embedding-3-small', fetch: f as never });
    expect(v.indexModel).toBe('gpt-x|text-embedding-3-small|512');
    expect(await v.describe({ url: 'https://shop.example/a.jpg' })).toEqual({ text: 'red dress', inputTokens: 90, outputTokens: 6 });
    await v.describe({ data: Buffer.from([1, 2, 3]), mime: 'image/png' });
    const bodies = f.mock.calls.map((c) => JSON.parse(String(c[1]!.body)));
    expect(bodies[0]).toEqual({
      model: 'gpt-x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: DESCRIBE_PROMPT },
            { type: 'image_url', image_url: { url: 'https://shop.example/a.jpg', detail: 'low' } },
          ],
        },
      ],
      max_completion_tokens: 200,
    });
    expect(bodies[1].messages[0].content[1].image_url.url).toBe('data:image/png;base64,AQID');
    expect(f.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions');
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer sk-test');

    expect([...(await v.embed('red dress'))]).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(JSON.parse(String(f.mock.calls[2]![1]!.body))).toEqual({ model: 'text-embedding-3-small', input: 'red dress', dimensions: 512 });
  });

  it('errors carry the status only, never the response body; 429/5xx are retryable', async () => {
    const f = vi.fn(async () => new Response('{"error":"echo of the prompt sk-test"}', { status: 400 }));
    const v = new OpenAiVision({ apiKey: 'sk-test', model: 'm', embeddingModel: 'e', fetch: f as never });
    const e = await v.describe({ url: 'https://x.example/a.jpg' }).catch((x) => x);
    expect(e).toBeInstanceOf(LlmError);
    expect(e).toMatchObject({ status: 400, retryable: false, message: 'OpenAI HTTP 400' });
    f.mockResolvedValueOnce(new Response('', { status: 503 }));
    expect(await v.embed('x').catch((x) => x)).toMatchObject({ status: 503, retryable: true });
  });

  it('cosine of unit vectors; mismatched sizes score 0', () => {
    const a = normalize(Float32Array.from([1, 1, 0]));
    expect(cosine(a, a)).toBeCloseTo(1);
    expect(cosine(a, normalize(Float32Array.from([0, 0, 1])))).toBe(0);
    expect(cosine(a, Float32Array.from([1, 0]))).toBe(0);
  });

  it('image type comes from magic bytes, not headers', () => {
    expect(imageMime(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0]))).toBe('image/jpeg');
    expect(imageMime(Buffer.from('89504e470d0a1a0a0000', 'hex'))).toBe('image/png');
    expect(imageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(imageMime(Buffer.from('GIF89a..'))).toBe('image/gif');
    expect(imageMime(Buffer.from('<html>not an image</html>'))).toBeNull();
  });
});
