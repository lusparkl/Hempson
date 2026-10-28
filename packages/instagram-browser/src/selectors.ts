/**
 * ALL Instagram UI knowledge lives in this file (locators + DOM extraction).
 *
 * CALIBRATION STATUS: read path calibrated against real instagram.com (en UI, 2026-10) — see CALIBRATION_STATUS.
 * Locators use roles/labels/structure, never generated class names. The synthetic local fixture
 * (tests/fixtures/fake-instagram.ts) mirrors the observed shape. Wrong/missing matches must raise UI_CHANGED,
 * never be guessed. Re-run `pnpm calibrate <accountId>` after any Instagram change.
 */
import type { Locator, Page } from 'playwright';
import { ConnectorError } from '@hepson/connector-core';
import { normalizeHandle, threadIdFromHref, type RawConversationRow, type RawMessageRow } from './parsers';

/** Calibrated 2026-10-28 on one authorized account, English UI, primary inbox, 1:1 text chats. */
export const CALIBRATION_STATUS = 'calibrated-en-2026-10' as const;

const L10N = {
  profile: /(profile|профіль)/i,
  send: /^(send|надіслати)$/i,
};

export type PageState = 'login' | 'checkpoint' | 'other';

const THREAD_PATH = /^\/direct\/t\/[A-Za-z0-9_-]{3,}/;
const LOGIN_PATH = /^\/accounts\/(login|emaillogin|password)/;
const CHECKPOINT_PATH = /^\/(challenge|checkpoint|accounts\/suspended|accounts\/disabled|accounts\/login\/two_factor|auth_platform)/;

/** URL-based first, then a generic password-input check (works regardless of Instagram's markup). */
export async function classifyPage(page: Page, baseUrl: string): Promise<PageState> {
  const u = new URL(page.url());
  if (u.origin !== new URL(baseUrl).origin) return 'other';
  if (CHECKPOINT_PATH.test(u.pathname)) return 'checkpoint';
  if (LOGIN_PATH.test(u.pathname)) return 'login';
  if ((await page.locator('input[type="password"]').count()) > 0) return 'login';
  return 'other';
}

/**
 * Own handle: the left-nav link to the profile. Calibrated 2026-10 (en UI): accessible name is
 * "<handle>'s profile picture" (image alt), href "/<handle>/". Nav links precede <main> in DOM order, so
 * `.first()` is the nav link, not the "Open the profile page of …" link inside a thread.
 */
export async function readOwnHandle(page: Page): Promise<string | null> {
  const link = page.getByRole('link', { name: L10N.profile }).first();
  if ((await link.count()) === 0) return null;
  const href = await link.getAttribute('href');
  const m = href && /^\/([A-Za-z0-9._]+)\/?$/.exec(href);
  return m ? normalizeHandle(m[1]!) : null;
}

/**
 * Calibrated 2026-10: thread-list rows are `div[role=button]` (NOT anchors; no href, no thread id) inside
 * the `navigation` landmark of <main>. A row is identified by its avatar `img[alt=user-profile-picture]`
 * (the "Your note" tile and nested "More options" buttons lack it). Row text spans, in order:
 * title, preview ("You: …" / "Active 1m ago"), relative time ("2y" inside <abbr>).
 */
export const threadRows = (page: Page): Locator => page.getByRole('main').locator('[role="navigation"] [role="button"]:has(img[alt="user-profile-picture"])');

export async function inboxReady(page: Page): Promise<boolean> {
  if (!new URL(page.url()).pathname.startsWith('/direct/')) return false;
  return (await page.getByRole('main').count()) > 0;
}

/**
 * The inbox SPA renders rows after DOMContentLoaded. Reading too early yields an empty list, which the service
 * would take as "empty inbox" and mark the baseline done => all old history later looks new. Wait until the row
 * count is stable; an empty list must stay empty for a few seconds before it is believed.
 * (The list always shows a permanent "Loading..." sentinel, so its absence cannot be used.)
 */
export async function settleThreadList(page: Page, maxMs = 12_000): Promise<void> {
  const start = Date.now();
  let last = -1;
  let stable = 0;
  while (Date.now() - start < maxMs) {
    const n = await threadRows(page)
      .count()
      .catch(() => -1);
    stable = n === last ? stable + 1 : 0;
    last = n;
    if (stable >= 3 && (n > 0 || Date.now() - start > 4000)) return;
    await page.waitForTimeout(400).catch(() => undefined);
  }
}

// NOTE: callbacks passed to evaluate*() run in the page. Do not declare named inner functions/arrow consts in
// them: tsx/esbuild (keepNames) injects a `__name` helper that does not exist in the page.
export async function extractConversationRows(page: Page): Promise<RawConversationRow[]> {
  return threadRows(page).evaluateAll((els) =>
    els.map((row) => {
      const spans = [...row.querySelectorAll('span[dir="auto"]')];
      return {
        href: '', // not exposed by the real UI; resolved by openThreadRow()
        title: spans[0]?.textContent?.replace(/\s+/g, ' ').trim() || null,
        preview: spans[1]?.textContent?.replace(/\s+/g, ' ').trim() || null,
        datetime: null, // only relative times ("2y") are shown => never trusted as a timestamp
        relativeTime: row.querySelector('abbr')?.textContent?.trim() || null,
        unread: null,
        handles: [] as string[],
      };
    }),
  );
}

/**
 * The real list has no hrefs, so the thread id is learned by selecting the row and reading the SPA URL
 * (/direct/t/<id>/). Selecting a chat marks it read for the owner — documented in LIMITATIONS.md.
 * Returns null (never a guess) if the URL did not change to a different thread.
 */
export async function openThreadRow(page: Page, index: number): Promise<string | null> {
  const row = threadRows(page).nth(index);
  if ((await row.count()) === 0) return null;
  if ((await row.getAttribute('aria-pressed')) === 'true') return threadIdFromHref(new URL(page.url()).pathname);
  const before = new URL(page.url()).pathname;
  await row.click();
  const moved = await page
    .waitForURL((u) => u.pathname !== before && THREAD_PATH.test(u.pathname), { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  return moved ? threadIdFromHref(new URL(page.url()).pathname) : null;
}

/** Thread header title = first <h2> in <main> outside the thread-list landmark (that one holds the own handle). */
export async function readThreadTitle(page: Page): Promise<string | null> {
  return page.getByRole('main').evaluate((m) => {
    for (const h of m.querySelectorAll('h2')) if (!h.closest('[role="navigation"]')) return h.textContent?.replace(/\s+/g, ' ').trim() || null;
    return null;
  });
}

/**
 * Calibrated 2026-10: every message is a `role=group` holding a `role=article` (the bubble) plus a
 * "Message actions" group whose buttons are labelled "React to message from <handle>" — that handle is the
 * sender, so direction = (sender == own handle). Separators with the date/time are plain text, not ISO.
 */
export const messageRows = (page: Page): Locator => page.getByRole('main').locator('[role="group"]:has([role="article"])');

/** Wait until the lazily rendered history stops growing (the SPA fills the thread after the composer appears). */
export async function settleMessages(page: Page, maxMs = 6000): Promise<void> {
  const start = Date.now();
  let last = -1;
  let stable = 0;
  while (Date.now() - start < maxMs) {
    const n = await messageRows(page)
      .count()
      .catch(() => -1);
    stable = n === last ? stable + 1 : 0;
    last = n;
    if (stable >= 4 && (n > 0 || Date.now() - start > 2500)) return;
    await page.waitForTimeout(400).catch(() => undefined);
  }
}

export async function extractMessageRows(page: Page, ownHandle: string | null): Promise<RawMessageRow[]> {
  return messageRows(page).evaluateAll(
    (els, own) =>
      els.map((g) => {
        const article = g.querySelector('[role="article"]')!;
        // innerText drops emoji (rendered as <img alt="😀">), so rebuild text from the node tree.
        let text = '';
        const media: Array<'image' | 'video' | 'audio' | 'other'> = [];
        const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.nodeType === 3) text += n.textContent ?? '';
          else if (n instanceof HTMLImageElement) {
            const w = n.getBoundingClientRect().width;
            if (n.alt && w <= 32) text += n.alt;
            else if (w > 32) media.push('image');
          } else if (n instanceof HTMLVideoElement) media.push('video');
          else if (n instanceof HTMLAudioElement) media.push('audio');
        }
        const react = g.querySelector('[aria-label^="React to message from "], [aria-label*="повідомлення від "]');
        const m = /(?:message from|повідомлення від)\s+(\S+)\s*$/i.exec(react?.getAttribute('aria-label') ?? '');
        const sender = m ? m[1]!.replace(/^@/, '').toLowerCase() : null;
        const align: 'left' | 'right' | 'unknown' = !sender || !own ? 'unknown' : sender === own ? 'right' : 'left';
        return { id: null, text: text.trim() ? text : null, datetime: null, align, sender, media };
      }),
    ownHandle,
  );
}

/**
 * Calibrated 2026-10: the composer is a Lexical contenteditable with NO accessible name (the search box is a
 * named textbox). The "Send" button exists only while the composer holds text. Exactly one match required.
 */
export function composer(page: Page): Locator {
  return page.getByRole('main').locator('[role="textbox"][contenteditable="true"]');
}
export function sendButton(page: Page): Locator {
  return page.getByRole('main').getByRole('button', { name: L10N.send });
}

export async function requireSingle(loc: Locator, what: string, operation: string): Promise<Locator> {
  const n = await loc.count();
  if (n !== 1) throw new ConnectorError('UI_CHANGED', `Expected exactly one ${what}, found ${n}`, { operation });
  return loc;
}
