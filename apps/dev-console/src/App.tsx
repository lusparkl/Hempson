import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client, type Acc, type Conv, type Ev, type Msg, type Outbox } from './api';

const uuid = () => crypto.randomUUID();

export function App() {
  const [key, setKey] = useState(() => sessionStorage.getItem('hepson_key') ?? '');
  const api = useMemo(() => client(key), [key]);
  const [accounts, setAccounts] = useState<Acc[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [conv, setConv] = useState<Conv | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [outbox, setOutbox] = useState<Outbox[]>([]);
  const [err, setErr] = useState('');
  const [text, setText] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newType, setNewType] = useState<'mock' | 'instagram-browser'>('mock');
  const [consent, setConsent] = useState(false);
  const [handle, setHandle] = useState('');
  const account = accounts.find((a) => a.accountId === sel) ?? null;

  const guard = useCallback(async (fn: () => Promise<unknown>) => { try { setErr(''); await fn(); } catch (e) { setErr(`${(e as { code?: string }).code ?? ''} ${(e as Error).message}`); } }, []);
  const loadAccounts = useCallback(() => guard(async () => { if (key) setAccounts((await api.req<{ items: Acc[] }>('GET', '/v1/accounts')).items); }), [api, key, guard]);
  const loadConvs = useCallback(() => guard(async () => { if (sel) setConvs((await api.req<{ items: Conv[] }>('GET', `/v1/accounts/${sel}/conversations?limit=100`)).items); }), [api, sel, guard]);
  const loadMsgs = useCallback(() => guard(async () => { if (sel && conv) setMsgs((await api.req<{ items: Msg[] }>('GET', `/v1/accounts/${sel}/conversations/${conv.id}/messages?limit=100`)).items); }), [api, sel, conv, guard]);
  const loadOutbox = useCallback(() => guard(async () => { if (sel) setOutbox((await api.req<{ items: Outbox[] }>('GET', `/v1/accounts/${sel}/outbox`)).items); }), [api, sel, guard]);

  useEffect(() => { void loadAccounts(); const t = setInterval(loadAccounts, 3000); return () => clearInterval(t); }, [loadAccounts]);
  useEffect(() => { setConv(null); setMsgs([]); setEvents([]); setConvs([]); if (!sel) return; void loadConvs(); void loadOutbox(); const ac = new AbortController();
    api.stream(sel, 0, (e) => { setEvents((p) => [e, ...p].slice(0, 60)); void loadConvs(); void loadOutbox(); }, ac.signal); return () => ac.abort(); }, [sel, api]); // eslint-disable-line
  useEffect(() => { void loadMsgs(); }, [loadMsgs, events.length]);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => bottom.current?.scrollIntoView(), [msgs]);

  const post = (path: string, body: unknown = {}) => guard(async () => { await api.req('POST', `/v1/accounts/${sel}${path}`, body); await loadAccounts(); });
  const isMock = account?.connectorType === 'mock';

  return (
    <>
      <header>
        <b>Hepson · Instagram connector · dev console</b>
        <input type="password" placeholder="API key (hep_…)" value={key} onChange={(e) => { setKey(e.target.value); sessionStorage.setItem('hepson_key', e.target.value); }} />
        {err && <span style={{ color: '#ffb4ab' }}>⚠ {err}</span>}
      </header>
      <main>
        <section>
          <h3>Accounts</h3>
          {accounts.map((a) => (
            <div key={a.accountId} className={`row ${a.accountId === sel ? 'sel' : ''}`} onClick={() => setSel(a.accountId)}>
              <b>{a.label}</b><span className={`tag ${a.connectorType === 'mock' ? 'mock' : 'real'}`}>{a.connectorType === 'mock' ? 'MOCK' : 'REAL'}</span><br />
              <span className={`status-${a.status}`}>{a.status}</span>
            </div>
          ))}
          <h3 style={{ marginTop: 14 }}>New account</h3>
          <input placeholder="label (e.g. fashion-shop-1)" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} /><br />
          <select value={newType} onChange={(e) => setNewType(e.target.value as 'mock')}><option value="mock">Mock (simulated)</option><option value="instagram-browser">Real Instagram (experimental browser)</option></select>
          {newType !== 'mock' && <>
            <input placeholder="expected IG handle (optional)" value={handle} onChange={(e) => setHandle(e.target.value)} />
            <label><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> The shop owner expressly authorized Hepson to access this inbox</label>
          </>}
          <br /><button disabled={!newLabel} onClick={() => guard(async () => { const a = await api.req<Acc>('POST', '/v1/accounts', { label: newLabel, connectorType: newType, consentConfirmed: newType === 'mock' ? false : consent, ...(handle ? { expectedInstagramHandle: handle } : {}) }); setNewLabel(''); setSel(a.accountId); await loadAccounts(); })}>Create</button>
        </section>

        <section>
          {!account ? <p>Select or create an account.</p> : <>
            <h3>{account.label} <span className={`tag ${isMock ? 'mock' : 'real'}`}>{account.dataSource}</span></h3>
            <div className={`banner ${['login_required', 'checkpoint_required', 'failed'].includes(account.status) ? 'warn' : ''}`}>
              <b className={`status-${account.status}`}>{account.status}</b> — {account.statusMessage}
              {account.restoredFromSavedLogin && <div>✔ Previous login restored automatically from the saved browser profile (no new login).</div>}
              {account.awaitingOwnerAction && <div>👉 Waiting for the shop owner to sign in / pass the check in the visible browser window.</div>}
              {account.lastErrorCode && <div>last error: <code>{account.lastErrorCode}</code></div>}
              <div>saved login on disk: {account.hasSavedLogin ? 'yes' : 'no'} · handle: {account.expectedInstagramHandle ?? '—'} · last validated: {account.lastAuthValidatedAt ?? '—'} · last sync: {account.lastSyncAt ?? '—'}</div>
            </div>
            <div>
              {isMock ? <button onClick={() => post('/session/start', { interactive: false })}>Start</button> : <>
                <button onClick={() => post('/session/start', { interactive: true })}>Start / initial login (opens browser)</button>
                <button onClick={() => post('/session/resume')}>Reconnect using saved session</button></>}
              <button onClick={() => post('/session/pause')}>Pause</button>
              <button onClick={() => post('/session/resume')}>Resume</button>
              <button onClick={() => post('/session/disconnect')}>Disconnect (keeps login)</button>
              <button className="danger" onClick={() => { const l = prompt(`FORGET saved login for "${account.label}"?\nThis permanently deletes the stored browser authentication; the owner must sign in again.\nType the account label to confirm:`); if (l !== null) void guard(async () => { await api.req('DELETE', `/v1/accounts/${sel}/session/profile`, { confirmLabel: l }); await loadAccounts(); }); }}>Forget saved login…</button>
            </div>
            <label><input type="checkbox" checked={account.outboundEnabled} onChange={(e) => guard(async () => { await api.req('PATCH', `/v1/accounts/${sel}/settings`, { outboundEnabled: e.target.checked }); await loadAccounts(); })} /> outboundEnabled (allow sending replies)</label>
            {isMock && <div style={{ marginTop: 6 }}>dev: <button onClick={() => conv?.providerConversationId && guard(async () => { await api.req('POST', `/v1/dev/accounts/${sel}/inject-incoming`, { providerConversationId: conv.providerConversationId, text: 'Тестове вхідне повідомлення ' + new Date().toLocaleTimeString() }); })}>simulate incoming</button>
              <button onClick={() => guard(async () => { await api.req('POST', `/v1/dev/accounts/${sel}/set-status`, { status: 'login_required' }); })}>simulate logout</button></div>}

            <h3 style={{ marginTop: 12 }}>Conversations</h3>
            <div style={{ maxHeight: 160, overflow: 'auto' }}>{convs.map((c) => <div key={c.id} className={`row ${conv?.id === c.id ? 'sel' : ''}`} onClick={() => setConv(c)}><b>{c.title}</b> {c.unread && '●'} <small>{c.participantHandles.join(', ')} · {c.latestMessageAt ?? 'time unknown'}</small></div>)}{convs.length === 0 && <i>none cached yet (needs connected session)</i>}</div>
            <h3 style={{ marginTop: 12 }}>Messages {conv && `· ${conv.title}`}</h3>
            <div style={{ maxHeight: 260, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
              {msgs.map((m) => <div key={m.id} className={`msg ${m.direction === 'incoming' ? 'in' : 'out'}`}>{m.text ?? <i>[unsupported {m.attachments.map((a) => a.kind).join(', ') || 'content'} — no text]</i>}<br /><small>{m.direction} · {m.deliveryStatus} · {m.sentAt ?? 'time unknown'}</small></div>)}<div ref={bottom} />
            </div>
            {conv && <div style={{ marginTop: 8 }}>
              <textarea rows={2} style={{ width: '100%' }} placeholder="Test reply…" value={text} onChange={(e) => setText(e.target.value)} />
              <button disabled={!text.trim() || !account.outboundEnabled} title={account.outboundEnabled ? '' : 'enable outboundEnabled first'} onClick={() => { if (confirm(`Send this REAL${isMock ? ' (mock)' : ''} reply to "${conv.title}"?\n\n${text}`)) void guard(async () => { await api.req('POST', `/v1/accounts/${sel}/conversations/${conv.id}/messages`, { text, idempotencyKey: uuid() }); setText(''); await loadOutbox(); }); }}>Send reply</button>
              {!account.outboundEnabled && <small> outbound is OFF</small>}
            </div>}
          </>}
        </section>

        <section>
          <h3>Outbox</h3>
          {outbox.map((o) => <div className="ev" key={o.outboxId}><b className={o.status === 'sent' ? 'status-connected' : o.status === 'queued' || o.status === 'sending' ? '' : 'status-login_required'}>{o.status}</b> {o.errorCode && <code>{o.errorCode}</code>} “{o.body.slice(0, 40)}”
            {o.needsReview && <div className="banner warn">Outcome UNCERTAIN — check Instagram manually. It will NOT be retried automatically. <button onClick={() => post(`/outbox/${o.outboxId}/review`)}>Mark reviewed</button></div>}</div>)}
          <h3 style={{ marginTop: 12 }}>Events (live, SSE)</h3>
          {events.map((e) => <div className="ev" key={e.id}><b>#{e.sequence} {e.type}</b> <small>{e.occurredAt.slice(11, 19)}</small><pre>{JSON.stringify(e.payload).slice(0, 160)}</pre></div>)}
        </section>
      </main>
    </>
  );
}
