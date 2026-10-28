/**
 * SYNTHETIC stand-in for instagram.com, used ONLY by automated tests against real Chromium.
 * It is NOT Instagram: DOM shape mirrors what was OBSERVED on the real inbox/thread in 2026-10 (see selectors.ts), but it is still our copy. It exists to
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

    const nav = `<nav><a href="/${user.handle}/" role="link"><img alt="${user.handle}'s profile picture" width="24" height="24" src="${PX}"></a></nav>`;
    // Shape mirrors the REAL inbox observed 2026-10: rows are div[role=button] (no href), title/preview/time in span[dir=auto].
    const list = (current: string | null) =>
      `<div role="navigation" aria-label="Thread list"><div><h2>${esc(user.handle)}</h2></div>` +
      [...user.threads.values()]
        .map((t) => {
          const last = t.messages.at(-1);
          const preview = last ? (last.from === 'me' ? 'You: ' : '') + (last.text ?? 'Sent an attachment') : '';
          return `<div role="button" tabindex="0" aria-pressed="${t.id === current}" onclick="location.href='/direct/t/${t.id}/'"><img alt="user-profile-picture" width="56" height="56" src="${PX}"><span dir="auto">${esc(t.title)}</span><span dir="auto">${esc(preview)}</span><span dir="auto"><abbr aria-label="${t.messages.length} minutes ago">${t.messages.length}m</abbr></span></div>`;
        })
        .join('') +
      `</div>`;
    if (u.pathname === '/direct/inbox/') return html(`${nav}<main>${list(null)}<h2>Your messages</h2></main>`);
    const tm = /^\/direct\/t\/([^/]+)\/$/.exec(u.pathname);
    if (tm) {
      const t = user.threads.get(tm[1]!);
      if (!t) return html('<main><h1>Not found</h1></main>', 404);
      const body = (m: FakeMsg) =>
        m.image
          ? `<img width="200" height="200" src="${PX}" alt="photo">`
          : `<span dir="auto"><div dir="auto">${esc(m.text ?? '').replace(/✅/g, `<img height="16" width="16" alt="✅" src="${PX}">`)}</div></span>`;
      const msgs = t.messages
        .map((m) => {
          const who = m.from === 'me' ? user.handle : t.handle;
          return `<div role="group" tabindex="-1" style="display:flex;justify-content:${m.from === 'me' ? 'flex-end' : 'flex-start'}"><div role="article" tabindex="0">${body(m)}</div><div role="group" aria-label="Message actions"><div role="button" aria-label="React to message from ${who}"></div><div role="button" aria-label="Reply to message from ${who}"></div></div></div>`;
        })
        .join('');
      // Lexical-like composer: unnamed contenteditable textbox; "Send" button exists only while it holds text.
      const composer =
        this.mode.sendMode === 'no-composer'
          ? ''
          : `<div data-pagelet="IGDComposerForCannes"><div contenteditable="true" role="textbox" tabindex="0" id="c"><p><br></p></div><div id="sw"></div></div>`;
      return html(`${nav}<main>${list(t.id)}<a href="/${t.handle}/" aria-label="Open the profile page of ${t.handle}"><h2>${this.mode.renameHeading ? '' : esc(t.title)}</h2></a>${msgs}${composer}</main>
<script>const c=document.getElementById('c'),sw=document.getElementById('sw');c?.addEventListener('input',()=>{const has=c.innerText.trim().length>0;if(has&&!sw.firstChild){const b=document.createElement('div');b.setAttribute('role','button');b.setAttribute('aria-label','Send');b.tabIndex=0;b.style.cssText='width:20px;height:20px;background:#08f';b.onclick=async()=>{const text=c.innerText.trim();if(!text)return;await fetch('/__send',{method:'POST',body:JSON.stringify({thread:${JSON.stringify(t.id)},text})});c.innerHTML='<p><br></p>';sw.innerHTML='';setTimeout(()=>location.reload(),150);};sw.appendChild(b);}else if(!has)sw.innerHTML='';});</script>`);
    }
    if (u.pathname.startsWith('/' + user.handle)) return html(`${nav}<main><h1>${user.handle}</h1></main>`);
    return html('<main>Home</main>' + nav);
  }
}
function redirect2(res: http.ServerResponse, to: string, headers: Record<string, string>) {
  res.writeHead(302, { location: to, ...headers });
  res.end();
}
const PX = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
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
