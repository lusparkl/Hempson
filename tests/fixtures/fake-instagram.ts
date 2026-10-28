/**
 * SYNTHETIC stand-in for instagram.com, used ONLY by automated tests against real Chromium.
 * It is NOT Instagram: DOM shape follows our own assumed contract (see selectors.ts). It exists to
 * prove profile/cookie persistence, state classification, parsing, dedupe and send semantics.
 * Contains no real customer content.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export type FakeMsg = { id: string; from: 'me' | 'them'; text: string | null; at: string | null; image?: boolean };
export type FakeThread = { id: string; title: string; handle: string; messages: FakeMsg[]; unread?: boolean };
type User = { handle: string; threads: Map<string, FakeThread> };

export class FakeInstagram {
  server!: http.Server;
  port = 0;
  users = new Map<string, User>();
  sessions = new Map<string, string>(); // token -> handle
  /** global behaviors */
  mode: { checkpoint: boolean; sendMode: 'ok' | 'no-echo' | 'no-composer'; renameHeading: boolean; sessionLife: number } = {
    checkpoint: false,
    sendMode: 'ok',
    renameHeading: false,
    sessionLife: 3600,
  };
  sendClicks = 0;

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  addUser(handle: string, threads: FakeThread[]) {
    this.users.set(handle, { handle, threads: new Map(threads.map((t) => [t.id, t])) });
  }
  injectIncoming(handle: string, threadId: string, text: string, at = new Date().toISOString()) {
    const t = this.users.get(handle)!.threads.get(threadId)!;
    t.messages.push({ id: randomUUID(), from: 'them', text, at });
    t.unread = true;
  }
  /** make the server forget a session token (simulates Instagram revoking the login) */
  revokeAll() {
    this.sessions.clear();
  }

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as { port: number }).port;
    return this;
  }
  async stop() {
    await new Promise((r) => this.server.close(r));
  }

  private cookieUser(req: http.IncomingMessage): User | null {
    const m = /fake_session=([^;]+)/.exec(req.headers.cookie ?? '');
    const handle = m && this.sessions.get(m[1]!);
    return handle ? (this.users.get(handle) ?? null) : null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url!, this.url);
    const html = (body: string, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    const redirect = (to: string) => {
      res.writeHead(302, { location: to });
      res.end();
    };
    const user = this.cookieUser(req);

    // test-only owner-login simulation: the "owner" completes login in the visible page.
    if (u.pathname === '/__login') {
      const handle = u.searchParams.get('user')!;
      const token = randomUUID();
      this.sessions.set(token, handle);
      return redirect2(res, '/direct/inbox/', { 'set-cookie': `fake_session=${token}; Max-Age=${this.mode.sessionLife}; Path=/; HttpOnly` });
    }
    if (u.pathname === '/accounts/login/')
      return html(`<main><h1>Log in</h1><form><input name="username" aria-label="Username"><input type="password" name="password" aria-label="Password"></form></main>`);
    if (u.pathname === '/challenge/') return html(`<main><h1>Confirm it's you</h1></main>`);
    if (u.pathname === '/__send') {
      this.sendClicks++;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { thread, text } = JSON.parse(body);
        if (user && this.mode.sendMode === 'ok') user.threads.get(thread)?.messages.push({ id: randomUUID(), from: 'me', text, at: new Date().toISOString() });
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (!user) return redirect('/accounts/login/');
    if (this.mode.checkpoint) return redirect('/challenge/');

    const nav = `<nav><a href="/${user.handle}/" aria-label="Profile">Profile</a></nav>`;
    if (u.pathname === '/direct/inbox/') {
      const rows = [...user.threads.values()].map((t) => {
        const last = t.messages.at(-1);
        return `<a href="/direct/t/${t.id}/" aria-label="${esc(t.title)}" data-handles="${t.handle}" data-unread="${t.unread ? 'true' : 'false'}"><span data-role="title">${esc(t.title)}</span><span data-role="preview">${esc(last?.text ?? '')}</span>${last?.at ? `<time datetime="${last.at}">x</time>` : ''}</a>`;
      });
      return html(`${nav}<main><h2>Chats</h2>${rows.join('')}</main>`);
    }
    const tm = /^\/direct\/t\/([^/]+)\/$/.exec(u.pathname);
    if (tm) {
      const t = user.threads.get(tm[1]!);
      if (!t) return html('<main><h1>Not found</h1></main>', 404);
      const rows = t.messages
        .map(
          (m) =>
            `<div role="row" data-message-id="${m.id}" data-sender="${m.from === 'me' ? 'me' : esc(t.title)}" style="display:flex;justify-content:${m.from === 'me' ? 'flex-end' : 'flex-start'}"><div data-role="bubble" style="max-width:50%">${m.image ? '<img data-media src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20" alt="photo">' : ''}${m.text !== null ? `<span data-role="text">${esc(m.text)}</span>` : ''}${m.at ? `<time datetime="${m.at}">t</time>` : ''}</div></div>`,
        )
        .join('');
      const composer = this.mode.sendMode === 'no-composer' ? '' : `<textarea aria-label="Message" id="c"></textarea><button type="button" id="s">Send</button>`;
      return html(`${nav}<main><h1 ${this.mode.renameHeading ? 'hidden' : ''}>${this.mode.renameHeading ? '' : esc(t.title)}</h1><div role="grid" style="width:600px">${rows}</div>${composer}</main>
<script>document.getElementById('s')?.addEventListener('click',async()=>{const c=document.getElementById('c');const text=c.value;if(!text)return;await fetch('/__send',{method:'POST',body:JSON.stringify({thread:${JSON.stringify(t.id)},text})});c.value='';setTimeout(()=>location.reload(),150);});</script>`);
    }
    if (u.pathname.startsWith('/' + user.handle)) return html(`${nav}<main><h1>${user.handle}</h1></main>`);
    return html('<main>Home</main>' + nav);
  }
}
function redirect2(res: http.ServerResponse, to: string, headers: Record<string, string>) {
  res.writeHead(302, { location: to, ...headers });
  res.end();
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const seedThreads = (): FakeThread[] => [
  {
    id: 'abc111',
    title: 'Олена Коваль',
    handle: 'olena.koval',
    messages: [
      { id: 'm1', from: 'them', text: 'Доброго дня! Є сукня M?', at: '2026-10-20T09:00:00.000Z' },
      { id: 'm2', from: 'me', text: 'Вітаю! Так, є.', at: '2026-10-20T09:05:00.000Z' },
      { id: 'm3', from: 'them', text: null, at: null, image: true },
    ],
  },
  { id: 'def222', title: 'Андрій Мельник', handle: 'andrii_m', messages: [{ id: 'm4', from: 'them', text: 'Скільки коштує ремінь?', at: '2026-10-21T10:00:00.000Z' }] },
];
