import type { Page } from 'playwright';
import { ConnectorError, type ConnectorStatus } from '@hepson/connector-core';
import { normalizeHandle } from './parsers';
import { classifyPage, inboxReady, readOwnHandle } from './selectors';

export type SessionDeps = { baseUrl: string; loginWaitMs: number; setStatus: (s: ConnectorStatus, d?: { code?: string; message?: string }) => void };
export type EstablishOutcome = { state: 'connected'; handle: string } | { state: 'login_required' } | { state: 'checkpoint_required' };

/** Throws LOGIN_REQUIRED / CHECKPOINT_REQUIRED when the current page is not a normal logged-in page. */
export async function checkPageForChallenge(page: Page, baseUrl: string): Promise<void> {
  const st = await classifyPage(page, baseUrl);
  if (st === 'login') throw new ConnectorError('LOGIN_REQUIRED', 'Instagram is asking for login');
  if (st === 'checkpoint') throw new ConnectorError('CHECKPOINT_REQUIRED', 'Instagram security check; owner must complete it manually');
}

/** Identity gate: restored profile must belong to the expected shop handle, else fail closed. */
export function assertIdentity(observed: string | null, expected: string | null): string {
  if (!observed) throw new ConnectorError('UI_CHANGED', 'Cannot confirm which Instagram account is signed in; refusing to attach conversations', { operation: 'identity' });
  const o = normalizeHandle(observed);
  if (expected && normalizeHandle(expected) !== o)
    throw new ConnectorError('IDENTITY_MISMATCH', 'Signed-in Instagram account differs from the one expected for this store; human review required');
  return o;
}

/**
 * Opens the app and decides whether the stored profile still has a valid session.
 * NEVER fills forms, injects cookies, or touches credentials: login/challenge => report and stop.
 */
export async function establishSession(page: Page, d: SessionDeps, o: { expectedHandle: string | null }): Promise<EstablishOutcome> {
  try {
    await page.goto(`${d.baseUrl}/direct/inbox/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (e) {
    throw new ConnectorError('TEMPORARY_FAILURE', `Could not reach Instagram: ${(e as Error).message.split('\n')[0]}`);
  }
  return classifyAfterNav(page, d, o);
}

async function classifyAfterNav(page: Page, d: SessionDeps, o: { expectedHandle: string | null }): Promise<EstablishOutcome> {
  const st = await classifyPage(page, d.baseUrl);
  if (st === 'login') return { state: 'login_required' };
  if (st === 'checkpoint') return { state: 'checkpoint_required' };
  if (!(await inboxReady(page))) throw new ConnectorError('UI_CHANGED', 'Inbox not accessible after load', { operation: 'establishSession' });
  const handle = assertIdentity(await readOwnHandle(page), o.expectedHandle);
  return { state: 'connected', handle };
}

export type WatchResult = EstablishOutcome | { state: 'timeout' } | { state: 'identity_mismatch' } | { state: 'aborted' };

/**
 * Interactive login: the OWNER types credentials/2FA in the visible window. We only watch the URL
 * and, once it leaves login/challenge pages, open the inbox to confirm. No automation of the forms.
 */
export async function watchForOwnerLogin(page: Page, d: SessionDeps, o: { expectedHandle: string | null; signal: AbortSignal; pollMs?: number }): Promise<WatchResult> {
  const end = Date.now() + d.loginWaitMs;
  let lastTry = 0;
  while (Date.now() < end && !o.signal.aborted) {
    await new Promise((r) => setTimeout(r, o.pollMs ?? 1500));
    if (o.signal.aborted) return { state: 'aborted' };
    if (page.isClosed()) return { state: 'login_required' } as WatchResult;
    try {
      const st = await classifyPage(page, d.baseUrl);
      if (st === 'checkpoint') {
        d.setStatus('checkpoint_required', { code: 'CHECKPOINT_REQUIRED' });
        continue;
      }
      if (st === 'login') {
        d.setStatus('login_required', { code: 'LOGIN_REQUIRED' });
        continue;
      }
      if (Date.now() - lastTry < 4000) continue;
      lastTry = Date.now();
      if (!new URL(page.url()).pathname.startsWith('/direct/inbox')) await page.goto(`${d.baseUrl}/direct/inbox/`, { waitUntil: 'domcontentloaded' });
      const r = await classifyAfterNav(page, d, o);
      if (r.state === 'connected') return r;
    } catch (e) {
      if (e instanceof ConnectorError && e.code === 'IDENTITY_MISMATCH') return { state: 'identity_mismatch' };
      if (page.isClosed()) return { state: 'login_required' } as WatchResult;
      // transient / UI_CHANGED during owner navigation: keep waiting
    }
  }
  return o.signal.aborted ? { state: 'aborted' } : { state: 'timeout' };
}
