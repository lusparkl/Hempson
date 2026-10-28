import type { ObservedConversation, ObservedMessage } from '@hepson/connector-core';
import { ConnectorError } from '@hepson/connector-core';

/** Raw rows are what selectors.ts pulls from the DOM; parsers turn them into normalized domain data. Pure + unit-tested. */
export type RawConversationRow = { href: string; title: string | null; preview: string | null; datetime: string | null; unread: boolean | null; handles: string[] };
export type RawMessageRow = {
  id: string | null;
  text: string | null;
  datetime: string | null;
  /** Where the bubble sits. 'unknown' => we refuse to guess a direction. */
  align: 'left' | 'right' | 'unknown';
  sender: string | null;
  media: Array<'image' | 'video' | 'audio' | 'other'>;
};

const THREAD_ID_RE = /\/direct\/t\/([A-Za-z0-9_-]{3,})\/?/;
export const threadIdFromHref = (href: string): string | null => THREAD_ID_RE.exec(href)?.[1] ?? null;

/** Only machine-readable ISO timestamps are trusted. Localized/relative text ("2 год", "Вчора") => null. */
export function parseTimestamp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export const normalizeHandle = (h: string) => h.trim().replace(/^@/, '').replace(/\/+$/, '').toLowerCase();
export const normalizeTitle = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

export function parseConversations(rows: RawConversationRow[]): ObservedConversation[] {
  const out: ObservedConversation[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const r of rows) {
    const id = threadIdFromHref(r.href);
    const title = r.title?.replace(/\s+/g, ' ').trim();
    if (!id || !title) {
      skipped++;
      continue;
    }
    if (seen.has(id)) continue; // duplicate anchors for same thread
    seen.add(id);
    out.push({
      providerConversationId: id,
      title,
      participantHandles: r.handles.map(normalizeHandle).filter(Boolean),
      latestMessageAt: parseTimestamp(r.datetime),
      unread: r.unread,
    });
  }
  if (rows.length > 0 && out.length === 0) throw new ConnectorError('UI_CHANGED', `No conversation row could be parsed (${skipped} skipped)`, { operation: 'listConversations' });
  return out;
}

export function parseMessages(rows: RawMessageRow[]): ObservedMessage[] {
  const out: ObservedMessage[] = [];
  for (const r of rows) {
    if (r.align === 'unknown') throw new ConnectorError('UI_CHANGED', 'Cannot determine message direction; refusing to guess', { operation: 'listMessages' });
    const text = r.text?.replace(/ /g, ' ').trim() || null;
    const attachments = r.media.map((kind) => ({ kind, metadata: { note: 'unsupported_media_placeholder' } }));
    if (!text && attachments.length === 0) continue; // empty decoration row
    out.push({
      providerMessageId: r.id ?? undefined,
      direction: r.align === 'right' ? 'outgoing' : 'incoming',
      senderDisplayName: r.sender ?? undefined,
      text, // never synthesize text for media-only rows
      attachments,
      sentAt: parseTimestamp(r.datetime),
      ordinal: out.length,
    });
  }
  return out;
}
