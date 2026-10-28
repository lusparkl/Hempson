import type { Page } from 'playwright';
import { ConnectorError, type SendOutcome } from '@hepson/connector-core';
import { composer, extractMessageRows, requireSingle, sendButton } from './selectors';
import { parseMessages } from './parsers';

const countOutgoingWith = async (page: Page, text: string) => {
  const msgs = parseMessages(await extractMessageRows(page));
  return msgs.filter((m) => m.direction === 'outgoing' && m.text === text).length;
};

/**
 * Contract: throws ConnectorError ONLY before the send click (safe => caller marks failed).
 * From the click onward every problem returns 'uncertain' — never retried here or by the caller.
 */
export async function sendTextInPage(page: Page, text: string, opts: { confirmMs?: number } = {}): Promise<SendOutcome> {
  const box = await requireSingle(composer(page), 'message composer', 'sendText');
  const btn = await requireSingle(sendButton(page), 'send button', 'sendText');
  const before = await countOutgoingWith(page, text);
  await box.fill(text);
  const typed = await box.inputValue().catch(() => null);
  if (typed !== text) throw new ConnectorError('UI_CHANGED', 'Composer did not accept the text as typed', { operation: 'sendText' });
  if (!(await btn.isEnabled())) throw new ConnectorError('UI_CHANGED', 'Send button is disabled', { operation: 'sendText' });

  // ---- point of no return ----
  try {
    await btn.click({ timeout: 5000 });
  } catch {
    return { status: 'uncertain', errorCode: 'SEND_OUTCOME_UNCERTAIN' };
  }
  const deadline = Date.now() + (opts.confirmMs ?? 8000);
  while (Date.now() < deadline) {
    try {
      if ((await countOutgoingWith(page, text)) > before) return { status: 'sent' };
    } catch {
      /* DOM mid-update; keep polling until the deadline, then uncertain */
    }
    await page.waitForTimeout(250).catch(() => undefined);
  }
  // Not confirmed. Leave nothing half-typed that a later action could submit by accident.
  await box.fill('').catch(() => undefined);
  return { status: 'uncertain', errorCode: 'SEND_OUTCOME_UNCERTAIN' };
}
