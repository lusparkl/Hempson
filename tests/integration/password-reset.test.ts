import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthRepository } from '@hepson/database';
import { RESET_TTL_MS } from '../../apps/api/src/auth/reset';
import { loadConfig } from '../../apps/api/src/config';
import { SmtpMailer, smtpOptions, type Mail } from '../../apps/api/src/services/mailer';
import { makeApp, call, type TestApp } from '../helpers';

const OLD = 'correct horse battery';
const NEW = 'a brand new passphrase';
const DASHBOARD = 'https://app.hepson.example';
const EMAIL = 'u@example.com';

let a: TestApp | undefined;
let smtp: Server | undefined;
afterEach(async () => {
  await a?.close();
  a?.cleanup();
  a = undefined;
  smtp?.close();
  smtp = undefined;
});

async function setup(over: { noMailer?: boolean } = {}) {
  const sent: Mail[] = [];
  a = await makeApp({ dashboardUrl: DASHBOARD, mailer: over.noMailer ? null : { send: async (m) => void sent.push(m) } });
  await call(a, null, 'POST', '/v1/auth/register', { email: EMAIL, displayName: 'U', password: OLD });
  const session = (await login(OLD)).body.token as string;
  return { sent, session, userId: a.auth.getUserByEmail(EMAIL)!.id };
}
const login = (password: string) => call(a!, null, 'POST', '/v1/auth/login', { email: EMAIL, password });
const request = (email = EMAIL) => call(a!, null, 'POST', '/v1/auth/password-reset/request', { email });
const confirm = (token: string, password = NEW) => call(a!, null, 'POST', '/v1/auth/password-reset/confirm', { token, password });
const tokenIn = (m: Mail) => /#reset=(\S+)/.exec(m.text)![1]!;
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('password reset', () => {
  it('emails a link to the dashboard, sets the password once and ends every session', async () => {
    const s = await setup();
    expect((await request(' U@Example.com ')).body).toEqual({ ok: true });
    await vi.waitFor(() => expect(s.sent).toHaveLength(1));
    expect(s.sent[0]!.to).toBe(EMAIL);
    expect(s.sent[0]!.text).toContain(`${DASHBOARD}/#reset=hpr_`);
    const token = tokenIn(s.sent[0]!);
    expect(a!.handle.raw.prepare('select hashed_token from password_resets').pluck().all()).not.toContain(token);

    expect((await confirm(token)).status).toBe(200);
    expect((await login(OLD)).status).toBe(401);
    expect((await login(NEW)).status).toBe(200);
    expect((await call(a!, s.session, 'GET', '/v1/auth/me')).status).toBe(401);
    await vi.waitFor(() => expect(s.sent).toHaveLength(2));
    expect(s.sent[1]!.subject).toBe('Пароль Hepson змінено');
    expect((await confirm(token, 'another long passphrase')).status).toBe(400);
    expect((await login('another long passphrase')).status).toBe(401);
  });

  it('answers the same for an unknown email and sends nothing', async () => {
    const s = await setup();
    const r = await request('nobody@example.com');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    await settle();
    expect(s.sent).toEqual([]);
    expect((await request('not an email')).body).toEqual({ ok: true });
  });

  it('a new link replaces the old one', async () => {
    const s = await setup();
    const first = a!.auth.createPasswordReset(s.userId, RESET_TTL_MS);
    const second = a!.auth.createPasswordReset(s.userId, RESET_TTL_MS);
    expect((await confirm(first)).status).toBe(400);
    expect((await confirm(second)).status).toBe(200);
  });

  it('refuses an expired link, and the purge removes it', async () => {
    const s = await setup();
    const token = a!.auth.createPasswordReset(s.userId, RESET_TTL_MS);
    const later = new AuthRepository(a!.handle, () => new Date(Date.now() + RESET_TTL_MS + 1000));
    expect(later.isPasswordResetLive(token)).toBe(false);
    expect(later.consumePasswordReset(token, 'x')).toBeUndefined();
    expect(later.purgeExpiredPasswordResets()).toBe(1);
    expect((await login(OLD)).status).toBe(200);
  });

  it('a too-short password leaves the link usable; a garbage token is refused', async () => {
    const s = await setup();
    const token = a!.auth.createPasswordReset(s.userId, RESET_TTL_MS);
    expect((await confirm(token, 'short')).status).toBe(400);
    expect((await confirm(token)).status).toBe(200);
    expect((await confirm('hpr_garbage')).status).toBe(400);
  });

  it('caps emails per address without changing the answer, and requests per IP with 429', async () => {
    const s = await setup();
    for (let i = 0; i < 5; i++) {
      expect((await request()).status).toBe(200);
      await settle();
    }
    expect(s.sent).toHaveLength(3);
    for (let i = 0; i < 5; i++) expect((await request(`x${i}@example.com`)).status).toBe(200);
    const r = await request('x9@example.com');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
  });

  it('clears the login lockout after a reset', async () => {
    const s = await setup();
    for (let i = 0; i < 5; i++) await login('wrong-password-1');
    expect((await login(OLD)).status).toBe(429);
    await confirm(a!.auth.createPasswordReset(s.userId, RESET_TTL_MS));
    expect((await login(NEW)).status).toBe(200);
  });

  it('without SMTP self-service says so, and an operator link still works', async () => {
    const s = await setup({ noMailer: true });
    const r = await request();
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('NOT_CONFIGURED');
    expect((await confirm(a!.auth.createPasswordReset(s.userId, RESET_TTL_MS))).status).toBe(200);
    expect((await login(NEW)).status).toBe(200);
  });
});

describe('SMTP mailer', () => {
  const base = { host: 'smtp.example.com', port: 587, user: undefined, password: undefined, from: 'Hepson <a@example.com>' };

  it('needs host and from', () => {
    expect(loadConfig({}).smtp).toBeNull();
    expect(loadConfig({ HEPSON_SMTP_HOST: 'x' }).smtp).toBeNull();
    expect(loadConfig({ HEPSON_SMTP_HOST: 'x', HEPSON_SMTP_FROM: 'a@b.c' }).smtp).toMatchObject({ host: 'x', port: 587 });
  });

  it('never allows plaintext to a remote server', () => {
    expect(smtpOptions(base)).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });
    expect(smtpOptions({ ...base, port: 465 })).toMatchObject({ secure: true, ignoreTLS: false });
    expect(smtpOptions({ ...base, host: '127.0.0.1' })).toMatchObject({ requireTLS: false, ignoreTLS: true });
  });

  it('delivers over SMTP', async () => {
    let received = '';
    smtp = createServer((c) => {
      let inData = false;
      c.setEncoding('utf8');
      c.write('220 test\r\n');
      c.on('data', (d: string) => {
        if (inData) {
          received += d;
          if (received.endsWith('\r\n.\r\n')) {
            inData = false;
            c.write('250 ok\r\n');
          }
        } else if (d.startsWith('DATA')) {
          inData = true;
          c.write('354 go\r\n');
        } else if (d.startsWith('QUIT')) c.end('221 bye\r\n');
        else c.write('250 ok\r\n');
      });
    });
    await new Promise<void>((r) => smtp!.listen(0, '127.0.0.1', r));
    const port = (smtp.address() as { port: number }).port;
    await new SmtpMailer({ ...base, host: '127.0.0.1', port }).send({ to: EMAIL, subject: 'Hi', text: 'https://x.example/#reset=abc' });
    expect(received).toContain('To: u@example.com');
    expect(received).toContain('#reset=abc');
  });
});
