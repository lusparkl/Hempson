import type { PhotoIndexRepository, PhotoIndexStatus, PhotoIndexTask, ShopMessageRow } from '@hepson/database';
import { LlmError } from '../agent/llm';
import { NO_PRODUCT, cosine, type VisionClient, type VisionImage } from '../agent/vision';
import { EgressDeniedError, hostOf, readCapped } from './egress';
import type { TelegramService } from './telegram';

type Logger = { info(o: object, m?: string): void; warn(o: object, m?: string): void };

/** Customer photos larger than this are not read (D36: in memory only, for one run). */
export const MAX_CUSTOMER_IMAGE_BYTES = 5_000_000;
/**
 * Cosine similarity of description embeddings. Not calibrated on real catalogs yet (D42): below `MIN_SCORE` nothing is
 * offered; at or above `CLOSE_SCORE` the agent may call it a close match, otherwise only "possibly similar".
 */
export const MIN_SCORE = 0.5;
export const CLOSE_SCORE = 0.7;
const BATCH = 10;

export type PhotoMatch = { productId: string; score: number; close: boolean };
export type PhotoSearchResult = { status: 'ok'; description: string; matches: PhotoMatch[] } | { status: 'no_product' } | { status: 'unreadable' } | { status: 'unavailable' };

/** Magic bytes of the formats the vision model accepts. Content-Type headers are not trusted (Telegram sends octet-stream). */
export function imageMime(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return 'image/gif';
  return null;
}

/**
 * P9 photo search (D36, D42). Catalog side: each active product's main image is described by the vision model and
 * embedded once; the provider fetches the image URL itself, so Hepson never requests an owner-supplied address.
 * Customer side: the photo is downloaded through egress (Telegram Bot API, or an Instagram CDN host the operator allowed),
 * described the same way, embedded, and compared with the shop's index. Customer bytes stay in memory for that call only.
 */
export class PhotoSearchService {
  private running: Promise<void> | null = null;
  private again = false;
  /** Set after a provider outage or rate limit: indexing waits for the next tick. */
  private pausedUntil = 0;

  constructor(
    private d: {
      repo: PhotoIndexRepository;
      vision: VisionClient;
      egress: typeof fetch;
      telegram?: TelegramService;
      log: Logger;
      now?: () => number;
    },
  ) {}

  private now() {
    return (this.d.now ?? Date.now)();
  }

  async status(shopId: string): Promise<PhotoIndexStatus> {
    return await this.d.repo.status(shopId, this.d.vision.indexModel);
  }

  async clearFailed(shopId: string): Promise<number> {
    return await this.d.repo.clearFailed(shopId);
  }

  /** Starts indexing in the background (after a catalog change); a call while it runs makes it go round once more. */
  schedule(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      do {
        this.again = false;
        while (this.now() >= this.pausedUntil && (await this.indexBatch(BATCH)) === BATCH);
      } while (this.again && this.now() >= this.pausedUntil);
    })()
      .catch((e) => this.d.log.warn({ err: e instanceof Error ? e.name : 'ERROR' }, 'photo indexing crashed'))
      .finally(() => {
        this.running = null;
      });
  }

  /** Resolves when no indexing is in flight (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Indexes up to `limit` products whose main image has no current entry. @returns how many were processed. */
  async indexBatch(limit: number, shopId?: string): Promise<number> {
    const model = this.d.vision.indexModel;
    const tasks = await this.d.repo.pending(model, limit, shopId);
    let done = 0;
    for (const task of tasks) {
      const r = await this.indexOne(task, model);
      if (r === 'retry_later') {
        this.pausedUntil = this.now() + 5 * 60_000;
        break;
      }
      done++;
    }
    return done;
  }

  private async indexOne(task: PhotoIndexTask, model: string): Promise<'ok' | 'failed' | 'retry_later'> {
    const { repo, vision, log } = this.d;
    try {
      const d = await vision.describe({ url: task.imageUrl });
      if (d.text.trim() === NO_PRODUCT) {
        await repo.saveFailed(task, model, 'NO_PRODUCT');
        return 'failed';
      }
      await repo.saveReady(task, model, d.text, await vision.embed(d.text));
      return 'ok';
    } catch (e) {
      if (e instanceof LlmError && e.retryable) {
        log.warn({ shopId: task.shopId, status: e.status ?? null }, 'photo indexing paused: provider unavailable');
        return 'retry_later';
      }
      // 400 from the provider: the image could not be downloaded or decoded. Logged by product only, never by URL.
      const code = e instanceof LlmError ? (e.status === 400 ? 'IMAGE_UNREADABLE' : `LLM_${e.status ?? 'ERROR'}`) : 'INTERNAL';
      log.warn({ shopId: task.shopId, productId: task.productId, code }, 'photo indexing failed');
      await repo.saveFailed(task, model, code);
      return 'failed';
    }
  }

  /** The newest customer photo among the trailing incoming messages that this server can fetch, or undefined. */
  static pickPhoto(trailing: ShopMessageRow[]): { kind: string; ref: string } | undefined {
    for (let i = trailing.length - 1; i >= 0; i--) {
      const a = trailing[i]!.attachments.filter((x) => (x.kind === 'image' || x.kind === 'post') && x.ref).at(-1);
      if (a) return { kind: a.kind, ref: a.ref! };
    }
    return undefined;
  }

  /** Downloads one customer photo into memory. Null when it cannot be read; the reason is logged without the URL. */
  async loadCustomerImage(shopId: string, channel: string, ref: string): Promise<VisionImage | null> {
    let bytes: Buffer | null = null;
    if (channel === 'telegram') bytes = (await this.d.telegram?.downloadImage(shopId, ref)) ?? null;
    else if (channel === 'instagram-official' && ref.startsWith('https://')) {
      try {
        const res = await this.d.egress(ref, { signal: AbortSignal.timeout(15_000) });
        // Egress never follows redirects, so a CDN answering with one is unreadable rather than followed.
        bytes = res.ok ? await readCapped(res, MAX_CUSTOMER_IMAGE_BYTES) : null;
        if (!res.ok) this.d.log.warn({ shopId, status: res.status, host: hostOf(ref) ?? null }, 'customer photo download refused');
      } catch (e) {
        // The host is logged so the operator can add the real Instagram CDN host to HEPSON_EGRESS_EXTRA_HOSTS (D42).
        this.d.log.warn(
          { shopId, err: e instanceof EgressDeniedError ? 'EGRESS_DENIED' : e instanceof Error ? e.name : 'ERROR', host: hostOf(ref) ?? null },
          'customer photo download failed',
        );
      }
    }
    const mime = bytes ? imageMime(bytes) : null;
    return bytes && mime ? { data: bytes, mime } : null;
  }

  /** Matches one image against the shop's index. Top `limit` products at or above `MIN_SCORE`, best first. */
  async search(shopId: string, image: VisionImage, limit: number): Promise<PhotoSearchResult> {
    try {
      const d = await this.d.vision.describe(image);
      if (d.text.trim() === NO_PRODUCT) return { status: 'no_product' };
      const q = await this.d.vision.embed(d.text);
      const matches = (await this.d.repo.entries(shopId, this.d.vision.indexModel))
        .map((e) => ({ productId: e.productId, score: cosine(q, e.vector) }))
        .filter((m) => m.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((m) => ({ ...m, score: Math.round(m.score * 1000) / 1000, close: m.score >= CLOSE_SCORE }));
      return { status: 'ok', description: d.text.slice(0, 500), matches };
    } catch (e) {
      if (e instanceof LlmError && e.status === 400) return { status: 'unreadable' };
      this.d.log.warn({ shopId, err: e instanceof LlmError ? `LLM_${e.status ?? 'ERROR'}` : e instanceof Error ? e.name : 'ERROR' }, 'photo search failed');
      return { status: 'unavailable' };
    }
  }
}
