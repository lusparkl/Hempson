import { chromium, type BrowserContext, type Page } from 'playwright';
import { ConnectorError } from '@hepson/connector-core';
import { ensureProfileDir, profileDir, ProfileLock } from './profile';

export type OpenedBrowser = { context: BrowserContext; page: Page; dir: string };

/**
 * Opens/closes the persistent Chromium context for one account. The user-data dir is the SAME
 * stable path on every start (<dataDir>/profiles/<accountUUID>); cookies + site storage live there.
 * No stealth flags, no proxies, no fingerprint changes.
 */
export class BrowserManager {
  private lock: ProfileLock;
  private open = new Set<string>();
  constructor(private o: { dataDir: string; headless: boolean; maxConcurrent: number }) {
    this.lock = new ProfileLock(o.dataDir);
  }
  get openCount() {
    return this.open.size;
  }
  async launch(accountId: string, onUnexpectedClose: () => void): Promise<OpenedBrowser> {
    if (this.open.size >= this.o.maxConcurrent && !this.open.has(accountId)) throw new ConnectorError('TEMPORARY_FAILURE', `Browser limit reached (${this.o.maxConcurrent}); pause another account first`);
    const dir = profileDir(this.o.dataDir, accountId);
    this.lock.acquire(accountId);
    try {
      ensureProfileDir(dir);
      const context = await chromium.launchPersistentContext(dir, { headless: this.o.headless, viewport: this.o.headless ? { width: 1280, height: 900 } : null });
      this.open.add(accountId);
      let intentional = false;
      (context as BrowserContext & { __intentional?: () => void }).__intentional = () => { intentional = true; };
      context.on('close', () => {
        this.open.delete(accountId);
        this.lock.release(accountId);
        if (!intentional) onUnexpectedClose();
      });
      const page = context.pages()[0] ?? (await context.newPage());
      return { context, page, dir };
    } catch (e) {
      this.lock.release(accountId);
      throw new ConnectorError('TEMPORARY_FAILURE', `Browser failed to start: ${(e as Error).message.split('\n')[0]}`, { cause: e });
    }
  }
  /** Graceful close so Chromium flushes cookies/storage to disk. Never deletes anything. */
  async close(accountId: string, context: BrowserContext | undefined): Promise<void> {
    if (context) {
      (context as BrowserContext & { __intentional?: () => void }).__intentional?.();
      await context.close().catch(() => undefined);
    }
    this.open.delete(accountId);
    this.lock.release(accountId);
  }
}
