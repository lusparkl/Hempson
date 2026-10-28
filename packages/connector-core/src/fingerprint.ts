import { createHash } from 'node:crypto';
import type { ObservedMessage } from './types';

/**
 * Deterministic message dedupe key, unique per (account). Used only when the provider id is
 * not reliably visible. Inputs: conversation + direction + sender + normalized text +
 * timestamp (or 'null') + `occurrence` = how many earlier identical (dir,text,ts) tuples were
 * already seen in the same thread snapshot (so "ok","ok" sent twice stay distinct).
 * It is intentionally NOT based on ordinal position, which shifts as history loads.
 * Known limit: two identical texts with null timestamps that become separated by new
 * messages keep their relative occurrence index, so they still map consistently.
 */
export function messageFingerprint(
  accountId: string,
  providerConversationId: string,
  m: Pick<ObservedMessage, 'providerMessageId' | 'direction' | 'senderDisplayName' | 'text' | 'sentAt' | 'attachments'>,
  occurrence: number,
): string {
  if (m.providerMessageId) return `pid:${sha(`${accountId}|${providerConversationId}|${m.providerMessageId}`)}`;
  const body = m.text ?? `[attachments:${m.attachments.map((a) => a.kind).join(',')}]`;
  const normalized = body.normalize('NFC').replace(/\s+/g, ' ').trim();
  return `fp:${sha([accountId, providerConversationId, m.direction, m.senderDisplayName ?? '', normalized, m.sentAt ?? 'null', occurrence].join('␟'))}`;
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 40);
}

/** Assign `occurrence` indices to a thread snapshot (oldest first). */
export function fingerprintAll(accountId: string, providerConversationId: string, items: ObservedMessage[]): string[] {
  const seen = new Map<string, number>();
  return items.map((m) => {
    const k = `${m.direction}|${m.senderDisplayName ?? ''}|${m.text ?? JSON.stringify(m.attachments)}|${m.sentAt ?? 'null'}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return messageFingerprint(accountId, providerConversationId, m, n);
  });
}
