import { LlmError } from './llm';

/** An image for the vision model: a public web URL the provider fetches itself, or bytes Hepson downloaded for this run only. */
export type VisionImage = { url: string } | { data: Buffer; mime: string };
export type VisionUsage = { inputTokens: number; outputTokens: number };

/** Photo search (P9, D42): describe a product image, and embed text. The agent only knows this interface. */
export interface VisionClient {
  /** Changes whenever descriptions or vectors would change; index entries built with another id are rebuilt. */
  readonly indexModel: string;
  describe(image: VisionImage): Promise<{ text: string } & VisionUsage>;
  embed(text: string): Promise<Float32Array>;
}

/**
 * One fixed instruction for catalog photos and customer photos alike, so both land in the same text space. English keeps
 * the vectors comparable whatever language the shop writes in; brand names and visible text are kept as written.
 */
export const DESCRIBE_PROMPT = [
  'Describe the main product in this photo for matching it against a shop catalog.',
  'Give: product type, colours, material or texture, pattern, cut or shape, notable details, and any visible brand name or text exactly as written.',
  'Ignore the background, the person wearing or holding it, and the photo quality. At most 60 words, plain English, no full sentences needed.',
  'If there is no product in the photo, answer exactly: NO_PRODUCT',
].join(' ');
export const NO_PRODUCT = 'NO_PRODUCT';

export type OpenAiVisionOptions = {
  apiKey: string;
  /** A chat model that accepts image input. */
  model: string;
  embeddingModel: string;
  /** Embedding size; smaller vectors keep the index small (text-embedding-3 models support shortening). */
  dimensions?: number;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

/** OpenAI Chat Completions (image input, low detail) and Embeddings over plain `fetch`. Response bodies are never copied into errors. */
export class OpenAiVision implements VisionClient {
  readonly indexModel: string;
  private base: string;
  private dims: number;
  private f: typeof fetch;
  constructor(private o: OpenAiVisionOptions) {
    this.dims = o.dimensions ?? 512;
    this.indexModel = `${o.model}|${o.embeddingModel}|${this.dims}`;
    this.base = (o.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.f = o.fetch ?? fetch;
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw new LlmError(e instanceof Error ? e.name : 'network error', true);
    }
    if (!res.ok) throw new LlmError(`OpenAI HTTP ${res.status}`, res.status === 429 || res.status >= 500, res.status);
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!j) throw new LlmError('OpenAI response was not JSON', false);
    return j;
  }

  async describe(image: VisionImage): Promise<{ text: string } & VisionUsage> {
    const url = 'url' in image ? image.url : `data:${image.mime};base64,${image.data.toString('base64')}`;
    const j = (await this.post('/chat/completions', {
      model: this.o.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: DESCRIBE_PROMPT },
            { type: 'image_url', image_url: { url, detail: 'low' } },
          ],
        },
      ],
      max_completion_tokens: 200,
    })) as { choices?: Array<{ message?: { content?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = j.choices?.[0]?.message?.content?.trim();
    if (!text) throw new LlmError('OpenAI returned no description', false);
    return { text, inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 };
  }

  async embed(text: string): Promise<Float32Array> {
    const j = (await this.post('/embeddings', { model: this.o.embeddingModel, input: text, dimensions: this.dims })) as { data?: Array<{ embedding?: number[] }> };
    const v = j.data?.[0]?.embedding;
    if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new LlmError('OpenAI returned no embedding', false);
    return normalize(Float32Array.from(v));
  }
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (!n) return v;
  return v.map((x) => x / n);
}

/** Cosine similarity of two unit vectors (dot product); 0 when the sizes differ. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
