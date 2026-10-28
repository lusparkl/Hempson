import type { Page } from 'playwright';
import { ConnectorError, type SendOutcome } from '@hepson/connector-core';
import { composer, extractMessageRows, requireSingle, sendButton } from './selectors';
import { parseMessages } from './parsers';

const countOutgoingWith = async (page: Page, text: string, ownHandle: string | null) => {
  const msgs = parseMessages(await extractMessageRows(page, ownHandle));
  return msgs.filter((m) => m.direction === 'outgoing' && m.text === text).length;
};

/**
 * Contract: throws ConnectorError ONLY before the send click (safe => caller marks failed).
 * From the click onward every problem returns 'uncertain' — never retried here or by the caller.
 */
export async function sendTextInPage(page: Page, text: string, opts: { confirmMs?: number; ownHandle?: string | null } = {}): Promise<SendOutcome> {
  const own = opts.ownHandle ?? null;
  const box = await requireSingle(composer(page), 'message composer', 'sendText');
  const before = await countOutgoingWith(page, text, own);
  await box.fill(text);
  // The composer is a contenteditable (no .value); an empty Lexical editor reads as "\n".
  const typed = await box.innerText().catch(() => null);
  if (typed?.trim() !== text.trim()) {
    await box.fill('').catch(() => undefined);
    throw new ConnectorError('UI_CHANGED', 'Composer did not accept the text as typed', { operation: 'sendText' });
  }
  // The Send button only exists once the composer holds text, so it is resolved after typing (still pre-click => safe to throw).
  const btn = sendButton(page);
  const n = await btn.count();
  if (n !== 1 || !(await btn.isEnabled())) {
    await box.fill('').catch(() => undefined);
    throw new ConnectorError('UI_CHANGED', n !== 1 ? `Expected exactly one send button, found ${n}` : 'Send button is disabled', { operation: 'sendText' });
  }

  // ---- point of no return ----
  try {
    await btn.click({ timeout: 5000 });
  } catch {
    return { status: 'uncertain', errorCode: 'SEND_OUTCOME_UNCERTAIN' };
  }
  const deadline = Date.now() + (opts.confirmMs ?? 8000);
  while (Date.now() < deadline) {
    try {
      if ((await countOutgoingWith(page, text, own)) > before) return { status: 'sent' };
    } catch {
      /* DOM mid-update; keep polling until the deadline, then uncertain */
    }
    await page.waitForTimeout(250).catch(() => undefined);
  }
  // Not confirmed. Leave nothing half-typed that a later action could submit by accident.
  await box.fill('').catch(() => undefined);
  return { status: 'uncertain', errorCode: 'SEND_OUTCOME_UNCERTAIN' };
}
