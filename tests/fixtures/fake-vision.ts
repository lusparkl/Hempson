import { LlmError } from '../../apps/api/src/agent/llm';
import { NO_PRODUCT, normalize, type VisionClient, type VisionImage } from '../../apps/api/src/agent/vision';

const DIMS = 256;

/**
 * Test double for the vision model (P9). Descriptions come from tables keyed by image URL or by the downloaded bytes; an
 * unknown image is a provider 400 ("could not fetch the image"). Embeddings are a hashed bag of words, so descriptions that
 * share words are close and unrelated ones are near 0. No network, no key.
 */
export class FakeVision implements VisionClient {
  indexModel = 'fake-vision|fake-embed|256';
  described: VisionImage[] = [];
  byUrl = new Map<string, string | Error>();
  byBytes = new Map<string, string>();

  async describe(image: VisionImage) {
    this.described.push(image);
    const d = 'url' in image ? this.byUrl.get(image.url) : this.byBytes.get(image.data.toString('latin1'));
    if (d instanceof Error) throw d;
    if (d === undefined) throw new LlmError('OpenAI HTTP 400', false, 400);
    return { text: d, inputTokens: 85, outputTokens: 20 };
  }

  async embed(text: string) {
    const v = new Float32Array(DIMS);
    for (const w of text
      .toLowerCase()
      .split(/[^\p{L}\p{N}-]+/u)
      .filter(Boolean)) {
      let h = 2166136261;
      for (const ch of w) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
      v[(h >>> 0) % DIMS]! += 1;
    }
    return normalize(v);
  }
}

export { NO_PRODUCT };
/** A tiny buffer that passes the JPEG magic-byte check; the tag makes each fake photo distinct. */
export const jpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag, 'latin1')]);
