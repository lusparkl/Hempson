/**
 * Guided selector calibration against a REAL, AUTHORIZED, already-logged-in account.
 *   pnpm calibrate <accountUUID> [--snapshot]
 * Opens the account's saved profile (visible window), navigates the inbox and reports, per locator in
 * packages/instagram-browser/src/selectors.ts, whether it matched. Prints counts/booleans only.
 * --snapshot also writes an ARIA snapshot to <dataDir>/calibration/ — it CONTAINS PRIVATE CHAT TEXT:
 * never commit, paste or share it; use it only to fix selectors locally.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BrowserManager,
  classifyPage,
  extractConversationRows,
  inboxReady,
  readOwnHandle,
  readThreadTitle,
  messageRows,
  composer,
  sendButton,
  threadIdFromHref,
} from '@hepson/instagram-browser';
import { loadConfig } from '../apps/api/src/config';

const [accountId, ...flags] = process.argv.slice(2);
if (!accountId) {
  console.error('usage: pnpm calibrate <accountUUID> [--snapshot]');
  process.exit(1);
}
const cfg = loadConfig();
const mgr = new BrowserManager({ dataDir: cfg.dataDir, headless: false, maxConcurrent: 1 });
const { page, context } = await mgr.launch(accountId, () => undefined);
const report: Record<string, unknown> = {};
try {
  await page.goto(`${cfg.instagramBaseUrl}/direct/inbox/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  report.pageState = await classifyPage(page, cfg.instagramBaseUrl);
  report.inboxReady = await inboxReady(page);
  report.ownHandleFound = (await readOwnHandle(page)) !== null;
  const rows = await extractConversationRows(page);
  report.conversationRows = rows.length;
  report.rowsWithThreadId = rows.filter((r) => threadIdFromHref(r.href)).length;
  report.rowsWithTitle = rows.filter((r) => r.title).length;
  report.rowsWithIsoTime = rows.filter((r) => r.datetime).length;
  const first = rows.find((r) => threadIdFromHref(r.href));
  if (first) {
    await page.goto(`${cfg.instagramBaseUrl}${first.href}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    report.threadTitleFound = (await readThreadTitle(page)) !== null;
    report.messageRows = await messageRows(page).count();
    report.composerMatches = await composer(page).count(); // must be exactly 1
    report.sendButtonMatches = await sendButton(page).count(); // 0 until text typed is possible; informative only
  }
  if (flags.includes('--snapshot')) {
    const dir = path.join(cfg.dataDir, 'calibration');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, `${accountId}-${Date.now()}.aria.txt`);
    writeFileSync(f, await page.locator('body').ariaSnapshot(), { mode: 0o600 });
    report.snapshotFile = f;
  }
} finally {
  await mgr.close(accountId, context);
}
console.log(JSON.stringify(report, null, 2));
console.log('\nAnything false/0 (or composerMatches != 1) means that locator needs fixing in selectors.ts (TODO(calibrate)).');
