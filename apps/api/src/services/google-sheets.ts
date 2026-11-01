/** A Google Sheets tab: spreadsheet id and tab id (`gid`, 0 = first tab). */
export type SheetRef = { id: string; gid: string };

export class SheetsError extends Error {
  constructor(readonly kind: 'not_public' | 'not_found' | 'too_large' | 'redirect_refused' | 'unavailable') {
    super(`google sheets: ${kind}`);
    this.name = 'SheetsError';
  }
}

const SHEET_URL = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})(?:[/?#]|$)/;
/** Google's per-file download hosts. Nothing else is followed. */
const DOWNLOAD_HOST = /^[a-z0-9-]{1,63}\.googleusercontent\.com$/;

/** Reads the spreadsheet id and tab from a pasted sheet link. The link itself is never fetched (D21/D35). */
export function parseSheetUrl(url: string): SheetRef | null {
  const m = SHEET_URL.exec(url.trim());
  if (!m) return null;
  const gid = /[#?&]gid=(\d{1,12})/.exec(url)?.[1] ?? '0';
  return { id: m[1]!, gid };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const len = Number(res.headers.get('content-length') ?? '0');
  if (len > maxBytes) throw new SheetsError('too_large');
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SheetsError('too_large');
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/**
 * Downloads one tab of a sheet shared "anyone with the link can view" as CSV (P8, D35). The URL is built here from the
 * id and tab, always `docs.google.com/.../export?format=csv`. One redirect is followed, and only to a googleusercontent
 * download host over https; a redirect to Google's sign-in page means the sheet is not public. Size-capped and timed out.
 */
export async function fetchSheetCsv(egress: typeof fetch, ref: SheetRef, opts: { maxBytes: number; timeoutMs?: number }): Promise<string> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const get = async (url: string) => {
    try {
      return await egress(url, { signal, headers: { accept: 'text/csv' } });
    } catch (e) {
      if (e instanceof Error && e.name === 'EgressDeniedError') throw new SheetsError('redirect_refused');
      throw new SheetsError('unavailable');
    }
  };
  let res = await get(`https://docs.google.com/spreadsheets/d/${ref.id}/export?format=csv&gid=${ref.gid}`);
  if (res.status >= 300 && res.status < 400) {
    let next: URL;
    try {
      next = new URL(res.headers.get('location') ?? '', 'https://docs.google.com');
    } catch {
      throw new SheetsError('redirect_refused');
    }
    if (next.hostname === 'accounts.google.com' || next.pathname.includes('ServiceLogin')) throw new SheetsError('not_public');
    if (next.protocol !== 'https:' || !DOWNLOAD_HOST.test(next.hostname) || next.username || next.password) throw new SheetsError('redirect_refused');
    res = await get(next.href);
    if (res.status >= 300 && res.status < 400) throw new SheetsError('redirect_refused');
  }
  if (res.status === 404) throw new SheetsError('not_found');
  if (res.status === 401 || res.status === 403) throw new SheetsError('not_public');
  if (!res.ok) throw new SheetsError('unavailable');
  // A private sheet can answer 200 with the sign-in page.
  if ((res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) throw new SheetsError('not_public');
  try {
    return await readCapped(res, opts.maxBytes);
  } catch (e) {
    if (e instanceof SheetsError) throw e;
    throw new SheetsError('unavailable');
  }
}
