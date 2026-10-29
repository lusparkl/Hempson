/* Hepson website chat widget. Embed:
 *   <script src="https://API_HOST/widget/web-chat.js" data-key="hwk_..." data-lang="uk" async></script>
 * No dependencies. All server text is inserted with textContent, never as HTML. */
(function () {
  var script = document.currentScript;
  if (!script || !script.src) return;
  var key = script.getAttribute('data-key');
  if (!key) return;
  var base = new URL(script.src).origin + '/public/web-chat/' + encodeURIComponent(key);
  var uk = (script.getAttribute('data-lang') || 'uk') !== 'en';
  var T = uk
    ? { title: 'Чат з магазином', ph: 'Напишіть повідомлення…', send: 'Надіслати', ai: 'Віртуальний асистент', err: 'Не вдалося надіслати. Спробуйте ще раз.', open: 'Відкрити чат' }
    : { title: 'Chat with the shop', ph: 'Write a message…', send: 'Send', ai: 'Virtual assistant', err: 'Could not send. Please try again.', open: 'Open chat' };
  var storeKey = 'hepson-chat-' + key;
  var token = null;
  try { token = localStorage.getItem(storeKey); } catch (e) {}
  var lastSeq = 0;
  var seen = {};
  var timer = null;
  var isOpen = false;

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text) n.textContent = text;
    return n;
  }
  function api(method, path, body) {
    var headers = { 'content-type': 'application/json' };
    if (token) headers['x-hepson-visitor'] = token;
    return fetch(base + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; });
    });
  }
  function newSession() {
    token = null;
    lastSeq = 0;
    seen = {};
    list.textContent = '';
    return api('POST', '/session', {}).then(function (r) {
      if (r.status !== 201) throw new Error('session');
      token = r.body.token;
      try { localStorage.setItem(storeKey, token); } catch (e) {}
    });
  }
  function ensure() { return token ? Promise.resolve() : newSession(); }

  var host = el('div', 'position:fixed;right:16px;bottom:16px;z-index:2147483000;font:14px/1.4 system-ui,sans-serif');
  var root = host.attachShadow({ mode: 'open' });
  var btn = el('button', 'width:56px;height:56px;border-radius:50%;border:0;background:#1f6feb;color:#fff;font-size:24px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)', '💬');
  btn.setAttribute('aria-label', T.open);
  var panel = el('div', 'display:none;flex-direction:column;position:absolute;right:0;bottom:68px;width:320px;max-width:calc(100vw - 32px);height:420px;max-height:calc(100vh - 100px);background:#fff;color:#111;border:1px solid #ccc;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.25)');
  var head = el('div', 'padding:10px 12px;background:#1f6feb;color:#fff;font-weight:600', T.title);
  var list = el('div', 'flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px');
  var note = el('div', 'padding:0 10px 4px;color:#b42318;font-size:12px;min-height:16px');
  var form = el('form', 'display:flex;gap:6px;padding:8px;border-top:1px solid #ddd');
  var input = el('input', 'flex:1;min-width:0;padding:8px;border:1px solid #bbb;border-radius:8px;font:inherit');
  input.maxLength = 1000;
  input.placeholder = T.ph;
  var send = el('button', 'padding:8px 12px;border:0;border-radius:8px;background:#1f6feb;color:#fff;font:inherit;cursor:pointer', T.send);
  send.type = 'submit';
  form.appendChild(input);
  form.appendChild(send);
  [head, list, note, form].forEach(function (n) { panel.appendChild(n); });
  root.appendChild(panel);
  root.appendChild(btn);

  function add(m) {
    if (seen[m.messageId]) return;
    seen[m.messageId] = true;
    if (m.seq > lastSeq) lastSeq = m.seq;
    var mine = m.from === 'visitor';
    var box = el('div', 'max-width:85%;padding:6px 10px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word;align-self:' + (mine ? 'flex-end;background:#dbeafe' : 'flex-start;background:#f1f1f1'));
    if (m.fromAi) box.appendChild(el('div', 'font-size:11px;color:#555;margin-bottom:2px', T.ai));
    box.appendChild(el('div', '', m.text));
    list.appendChild(box);
    list.scrollTop = list.scrollHeight;
  }
  function poll() {
    if (!token) return;
    api('GET', '/messages?afterSeq=' + lastSeq).then(function (r) {
      if (r.status === 401) return newSession();
      if (r.status === 200) r.body.items.forEach(add);
    }).catch(function () {});
  }
  function setOpen(v) {
    isOpen = v;
    panel.style.display = v ? 'flex' : 'none';
    clearInterval(timer);
    if (v) {
      ensure().then(poll).catch(function () { note.textContent = T.err; });
      timer = setInterval(poll, 3000);
      input.focus();
    }
  }
  btn.addEventListener('click', function () { setOpen(!isOpen); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    note.textContent = '';
    ensure()
      .then(function () { return api('POST', '/messages', { text: text }); })
      .then(function (r) {
        if (r.status === 401) return newSession().then(function () { note.textContent = T.err; });
        if (r.status !== 201) { note.textContent = T.err; return; }
        input.value = '';
        add(r.body.message);
      })
      .catch(function () { note.textContent = T.err; });
  });
  document.body.appendChild(host);
})();
