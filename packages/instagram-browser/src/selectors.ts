/**
 * ALL Instagram UI knowledge lives in this file (locators + DOM extraction).
 *
 * CALIBRATION STATUS: UNCALIBRATED against the real instagram.com.
 * No authorized live session was available when this was written. Every locator below is an
 * ASSUMPTION based on accessibility roles/labels (never generated class names) and is exercised
 * only against a synthetic local fixture (tests/fixtures/fake-instagram.ts).
 * Before pilot use run `pnpm calibrate <accountId>` with the shop owner's authorization and fix
 * every entry marked TODO(calibrate). Wrong/missing matches must raise UI_CHANGED, never be guessed.
 */
import type { Locator, Page } from 'playwright';
import { ConnectorError } from '@hepson/connector-core';
import { normalizeHandle, type RawConversationRow, type RawMessageRow } from './parsers';

export const CALIBRATION_STATUS = 'uncalibrated' as const;

const L10N = {
  profile: /^(profile|профіль)/i,
  message: /^(message|повідомлення)/i,
  send: /^(send|надіслати)$/i,
};

export type PageState = 'login' | 'checkpoint' | 'other';

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

/** TODO(calibrate): confirm the nav "Profile" link is exposed with an accessible name and /handle/ href. */
export async function readOwnHandle(page: Page): Promise<string | null> {
  const link = page.getByRole('link', { name: L10N.profile }).first();
  if ((await link.count()) === 0) return null;
  const href = await link.getAttribute('href');
  const m = href && /^\/([A-Za-z0-9._]+)\/?$/.exec(href);
  return m ? normalizeHandle(m[1]!) : null;
}

/** TODO(calibrate): confirm thread links look like /direct/t/<id>/ and sit in the main region. */
export const threadLinks = (page: Page): Locator => page.getByRole('main').locator('a[href*="/direct/t/"]');

export async function inboxReady(page: Page): Promise<boolean> {
  if (!new URL(page.url()).pathname.startsWith('/direct/')) return false;
  return (await page.getByRole('main').count()) > 0;
}

export async function extractConversationRows(page: Page): Promise<RawConversationRow[]> {
  return threadLinks(page).evaluateAll((els) =>
    els.map((a) => {
      const el = a as HTMLAnchorElement;
      const title = el.getAttribute('aria-label') || el.querySelector('[data-role="title"]')?.textContent || el.querySelector('span')?.textContent || null;
      const time = el.querySelector('time')?.getAttribute('datetime') ?? null;
      const unreadAttr = el.getAttribute('data-unread');
      return {
        href: el.getAttribute('href') ?? '',
        title,
        preview: el.querySelector('[data-role="preview"]')?.textContent ?? null,
        datetime: time,
        unread: unreadAttr === null ? null : unreadAttr === 'true',
        handles: (el.getAttribute('data-handles') ?? '').split(',').filter(Boolean),
      };
    }),
  );
}

/** TODO(calibrate): thread header title. Used to verify we opened the intended chat. */
export async function readThreadTitle(page: Page): Promise<string | null> {
  const h = page.getByRole('main').getByRole('heading').first();
  if ((await h.count()) === 0) return null;
  return (await h.innerText()).trim() || null;
}

/** TODO(calibrate): message rows assumed to be role=row inside the thread's grid/log. Alignment is a layout heuristic. */
export const messageRows = (page: Page): Locator => page.getByRole('main').getByRole('row');

export async function extractMessageRows(page: Page): Promise<RawMessageRow[]> {
  return messageRows(page).evaluateAll((els) =>
    els.map((row) => {
      const r = row as HTMLElement;
      const bubble = r.querySelector<HTMLElement>('[data-role="bubble"]') ?? r;
      const rowBox = r.parentElement?.getBoundingClientRect();
      const box = bubble.getBoundingClientRect();
      let align: 'left' | 'right' | 'unknown' = 'unknown';
      if (rowBox && rowBox.width > 0 && box.width > 0) {
        const left = box.left - rowBox.left;
        const right = rowBox.right - box.right;
        if (Math.abs(left - right) > rowBox.width * 0.1) align = left > right ? 'right' : 'left';
      }
      const media: Array<'image' | 'video' | 'audio' | 'other'> = [];
      r.querySelectorAll('img[data-media], img:not([data-avatar])').forEach(() => media.push('image'));
      r.querySelectorAll('video').forEach(() => media.push('video'));
      r.querySelectorAll('audio').forEach(() => media.push('audio'));
      const textEl = r.querySelector<HTMLElement>('[data-role="text"]');
      return {
        id: r.getAttribute('data-message-id'),
        text: textEl ? textEl.innerText : null,
        datetime: r.querySelector('time')?.getAttribute('datetime') ?? null,
        align,
        sender: r.getAttribute('data-sender'),
        media,
      };
    }),
  );
}

/** TODO(calibrate): composer textbox + send button accessible names. Exactly one match required. */
export function composer(page: Page): Locator {
  return page.getByRole('main').getByRole('textbox', { name: L10N.message });
}
export function sendButton(page: Page): Locator {
  return page.getByRole('main').getByRole('button', { name: L10N.send });
}

export async function requireSingle(loc: Locator, what: string, operation: string): Promise<Locator> {
  const n = await loc.count();
  if (n !== 1) throw new ConnectorError('UI_CHANGED', `Expected exactly one ${what}, found ${n}`, { operation });
  return loc;
}
