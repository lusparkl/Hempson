import { useState, type FormEvent } from 'react';
import { api, errText, useLoad, when, type Shop } from '../api';

type Conv = { conversationId: string; channel: string; lastMessageAt: string | null; aiPaused: boolean; customer: { displayName: string | null; handle: string | null } };
type Msg = { messageId: string; direction: 'incoming' | 'outgoing'; senderType: 'customer' | 'ai' | 'human' | 'system'; text: string | null; deliveryStatus: string; deliveryError: string | null; occurredAt: string };
const WHO = { customer: 'Клієнт', ai: 'ШІ', human: 'Менеджер', system: 'Система' } as const;

export function Inbox({ shop }: { shop: Shop }) {
  const base = `/v1/shops/${shop.shopId}`;
  const list = useLoad(() => api<{ items: Conv[] }>('GET', `${base}/conversations?limit=100`), [shop.shopId], 5000);
  const [sel, setSel] = useState<string | null>(null);
  const conv = list.data?.items.find((c) => c.conversationId === sel);

  return (
    <div className="split">
      <aside>
        {list.error && <p className="error">{list.error}</p>}
        {list.data?.items.length === 0 && <p className="muted">Розмов ще немає.</p>}
        <ul className="list">
          {list.data?.items.map((c) => (
            <li key={c.conversationId}>
              <button className={c.conversationId === sel ? 'active' : ''} onClick={() => setSel(c.conversationId)}>
                <strong>{c.customer.displayName ?? c.customer.handle ?? 'Клієнт'}</strong>
                <span className="muted">
                  {c.channel} · {when(c.lastMessageAt)}
                  {c.aiPaused ? ' · ШІ на паузі' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section>{conv ? <Thread key={conv.conversationId} base={base} conv={conv} onChange={list.reload} /> : <p className="muted">Оберіть розмову.</p>}</section>
    </div>
  );
}

function Thread({ base, conv, onChange }: { base: string; conv: Conv; onChange: () => void }) {
  const url = `${base}/conversations/${conv.conversationId}`;
  const msgs = useLoad(() => api<{ items: Msg[] }>('GET', `${url}/messages?limit=100`), [conv.conversationId], 4000);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const togglePause = async () => {
    try {
      await api('PUT', `${url}/ai`, { paused: !conv.aiPaused });
      onChange();
    } catch (e) {
      setErr(errText(e));
    }
  };
  const send = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const text = String(new FormData(form).get('text') ?? '').trim();
    if (!text) return;
    setBusy(true);
    setErr(null);
    try {
      await api('POST', `${url}/messages`, { text });
      form.reset();
      await msgs.reload();
      onChange();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="thread">
      <div className="bar">
        <strong>{conv.customer.displayName ?? conv.customer.handle ?? 'Клієнт'}</strong>
        <span className="muted">{conv.channel}</span>
        <button onClick={togglePause}>{conv.aiPaused ? 'Увімкнути ШІ' : 'Перехопити (пауза ШІ)'}</button>
      </div>
      <div className="messages">
        {msgs.data?.items.map((m) => (
          <div key={m.messageId} className={`msg ${m.direction}`}>
            <span className="muted">
              {WHO[m.senderType]} · {when(m.occurredAt)}
              {m.deliveryStatus === 'failed' ? ` · не надіслано (${m.deliveryError ?? '?'})` : m.deliveryStatus === 'uncertain' ? ' · невідомо, чи надіслано' : m.deliveryStatus === 'pending' ? ' · надсилається' : ''}
            </span>
            <div>{m.text}</div>
          </div>
        ))}
      </div>
      {err && <p className="error">{err}</p>}
      <form className="row" onSubmit={send}>
        <input name="text" placeholder="Відповісти клієнту (ШІ буде призупинено)" maxLength={1000} autoComplete="off" />
        <button type="submit" disabled={busy}>Надіслати</button>
      </form>
    </div>
  );
}
