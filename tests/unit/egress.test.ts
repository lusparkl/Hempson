import { describe, expect, it, vi } from 'vitest';
import { EgressDeniedError, createEgress } from '../../apps/api/src/services/egress';

const stub = () => vi.fn(async (_u: unknown, _i?: RequestInit) => new Response('{}'));

describe('egress guard (D22)', () => {
  it('allows only the built-in provider hosts over https', async () => {
    const f = stub();
    const egress = createEgress({ fetchImpl: f as never });
    for (const u of ['https://graph.facebook.com/x', 'https://graph.facebook.com/v26.0/oauth/access_token', 'https://api.telegram.org/bot1/sendMessage', 'https://api.openai.com/v1/chat/completions', 'https://api.novaposhta.ua/v2.0/json/', 'https://api.monobank.ua/api/merchant/invoice/create', 'https://api.wayforpay.com/api'])
      await egress(u);
    expect(f).toHaveBeenCalledTimes(7);
  });

  it('refuses everything else before calling the transport', () => {
    const f = stub();
    const egress = createEgress({ fetchImpl: f as never });
    for (const u of ['https://evil.example/x', 'https://graph.facebook.com.evil.example/x', 'http://graph.facebook.com/x', 'https://user:pw@graph.facebook.com/x', 'https://graph.instagram.com/x', 'https://169.254.169.254/latest/meta-data', 'http://127.0.0.1:9/x', 'ftp://graph.instagram.com/x', 'not a url'])
      expect(() => egress(u), u).toThrow(EgressDeniedError);
    expect(f).not.toHaveBeenCalled();
  });

  it('extra hosts are explicit; http works only for an allowed loopback host', async () => {
    const f = stub();
    const egress = createEgress({ extraHosts: ['http://127.0.0.1:9999', 'llm.example.org'], fetchImpl: f as never });
    await egress('http://127.0.0.1:9999/v1');
    await egress('https://llm.example.org/v1');
    expect(() => egress('http://llm.example.org/v1')).toThrow(EgressDeniedError);
    expect(() => egress('http://localhost:9999/v1')).toThrow(EgressDeniedError);
  });

  it('Google Sheets (D35): docs.google.com and single-label googleusercontent download hosts only', async () => {
    const f = stub();
    const egress = createEgress({ fetchImpl: f as never });
    await egress('https://docs.google.com/spreadsheets/d/x/export?format=csv');
    await egress('https://doc-0c-1a-sheets.googleusercontent.com/export/x');
    expect(f).toHaveBeenCalledTimes(2);
    for (const u of ['https://googleusercontent.com/x', 'https://a.b.googleusercontent.com/x', 'https://evilgoogleusercontent.com/x', 'https://googleusercontent.com.evil.example/x', 'http://doc-0c.googleusercontent.com/x', 'https://sheets.google.com/x'])
      expect(() => egress(u), u).toThrow(EgressDeniedError);
  });

  it('never follows redirects', async () => {
    const f = stub();
    await createEgress({ fetchImpl: f as never })('https://graph.facebook.com/x', { redirect: 'follow', headers: { authorization: 'Bearer t' } });
    expect(f.mock.calls[0]![1]).toMatchObject({ redirect: 'manual', headers: { authorization: 'Bearer t' } });
  });

  it('error text names the host only, not the path or query', () => {
    try {
      createEgress({ fetchImpl: stub() as never })('https://evil.example/path?access_token=SECRET');
    } catch (e) {
      expect(String(e)).toContain('evil.example');
      expect(String(e)).not.toContain('SECRET');
    }
  });
});
