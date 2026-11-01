import { describe, expect, it, vi } from 'vitest';
import { createEgress } from '../../apps/api/src/services/egress';
import { SheetsError, fetchSheetCsv, parseSheetUrl } from '../../apps/api/src/services/google-sheets';

// Google's responses below are modelled on documented/observed public-sheet behaviour, not captured live (D35).
const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc';
const ref = { id: ID, gid: '0' };
const csvRes = (body = 'sku,name\nA-1,Худі\n', headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', ...headers } });
const redirect = (location: string, status = 307) => new Response(null, { status, headers: { location } });
const make = (...answers: Response[]) => {
  const f = vi.fn(async (_u: unknown, _i?: RequestInit) => answers.shift() ?? new Response('', { status: 500 }));
  return { f, egress: createEgress({ fetchImpl: f as never }) };
};
const kind = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof SheetsError ? e.kind : String(e);
  }
};

describe('sheet links', () => {
  it('reads id and tab; anything not on docs.google.com over https is refused', () => {
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing#gid=123`)).toEqual({ id: ID, gid: '123' });
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=7#gid=7`)).toEqual({ id: ID, gid: '7' });
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}`)).toEqual({ id: ID, gid: '0' });
    for (const u of [
      `http://docs.google.com/spreadsheets/d/${ID}`,
      `https://docs.google.com.evil.example/spreadsheets/d/${ID}`,
      `https://evil.example/?u=https://docs.google.com/spreadsheets/d/${ID}`,
      'https://docs.google.com/spreadsheets/d/short',
      `https://docs.google.com/document/d/${ID}`,
    ])
      expect(parseSheetUrl(u), u).toBeNull();
  });
});

describe('sheet download', () => {
  it('fetches only the export URL it builds, never the pasted link', async () => {
    const { f, egress } = make(csvRes());
    expect(await fetchSheetCsv(egress, { id: ID, gid: '42' }, { maxBytes: 1000 })).toBe('sku,name\nA-1,Худі\n');
    expect(String(f.mock.calls[0]![0])).toBe(`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=42`);
    expect(f.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows one redirect to a googleusercontent download host', async () => {
    const { f, egress } = make(redirect('https://doc-0c-1a-sheets.googleusercontent.com/export/abc?format=csv'), csvRes('sku\nB-2\n'));
    expect(await fetchSheetCsv(egress, ref, { maxBytes: 1000 })).toBe('sku\nB-2\n');
    expect(String(f.mock.calls[1]![0])).toBe('https://doc-0c-1a-sheets.googleusercontent.com/export/abc?format=csv');
  });

  it('refuses every other redirect without calling it', async () => {
    for (const loc of [
      'https://evil.example/x',
      'http://doc-0c.googleusercontent.com/x',
      'https://a.b.googleusercontent.com/x',
      'https://googleusercontent.com.evil.example/x',
      'https://user:pw@doc-0c.googleusercontent.com/x',
      'https://169.254.169.254/latest',
    ]) {
      const { f, egress } = make(redirect(loc));
      expect(await kind(fetchSheetCsv(egress, ref, { maxBytes: 1000 })), loc).toBe('redirect_refused');
      expect(f).toHaveBeenCalledTimes(1);
    }
    const { egress } = make(redirect('https://doc-0c.googleusercontent.com/x'), redirect('https://doc-0d.googleusercontent.com/y'));
    expect(await kind(fetchSheetCsv(egress, ref, { maxBytes: 1000 }))).toBe('redirect_refused');
  });

  it('a private sheet, a missing sheet and an oversized sheet are named', async () => {
    expect(await kind(fetchSheetCsv(make(redirect('https://accounts.google.com/ServiceLogin?continue=x', 302)).egress, ref, { maxBytes: 1000 }))).toBe('not_public');
    expect(await kind(fetchSheetCsv(make(new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } })).egress, ref, { maxBytes: 1000 }))).toBe(
      'not_public',
    );
    expect(await kind(fetchSheetCsv(make(new Response('', { status: 401 })).egress, ref, { maxBytes: 1000 }))).toBe('not_public');
    expect(await kind(fetchSheetCsv(make(new Response('', { status: 404 })).egress, ref, { maxBytes: 1000 }))).toBe('not_found');
    expect(await kind(fetchSheetCsv(make(new Response('', { status: 500 })).egress, ref, { maxBytes: 1000 }))).toBe('unavailable');
    expect(await kind(fetchSheetCsv(make(csvRes('x', { 'content-length': '5000' })).egress, ref, { maxBytes: 1000 }))).toBe('too_large');
    expect(await kind(fetchSheetCsv(make(csvRes('y'.repeat(1500))).egress, ref, { maxBytes: 1000 }))).toBe('too_large');
  });
});
