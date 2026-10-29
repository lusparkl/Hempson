import { useState } from 'react';
import { api, errText, money, useLoad, when, type Shop } from '../api';

type Item = { sku: string; productName: string; options: Record<string, string>; quantity: number; unitPriceMinor: number };
type Draft = { draftId: string; status: string; createdBy: string; contactName: string | null; contactPhone: string | null; deliveryInfo: string | null; note: string | null; currency: string; totalMinor: number; createdAt: string; decisionNote: string | null; items: Item[] };
type Esc = { escalationId: string; conversationId: string; reason: string; createdAt: string };
const STATUS: Record<string, string> = { pending_approval: 'Очікують', approved: 'Підтверджені', rejected: 'Відхилені', cancelled: 'Скасовані' };

export function Orders({ shop }: { shop: Shop }) {
  const base = `/v1/shops/${shop.shopId}`;
  const [status, setStatus] = useState('pending_approval');
  const drafts = useLoad(() => api<{ items: Draft[] }>('GET', `${base}/order-drafts?status=${status}&limit=100`), [shop.shopId, status], 8000);
  const esc = useLoad(() => api<{ items: Esc[] }>('GET', `${base}/escalations?status=open`), [shop.shopId], 8000);
  const [err, setErr] = useState<string | null>(null);

  const act = async (path: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setErr(null);
    try {
      await api('POST', path, {});
      await Promise.all([drafts.reload(), esc.reload()]);
    } catch (e) {
      setErr(errText(e));
    }
  };

  return (
    <>
      {err && <p className="error">{err}</p>}
      <h2>Потрібна людина</h2>
      {esc.data?.items.length === 0 && <p className="muted">Немає відкритих запитів від ШІ.</p>}
      <ul className="cards">
        {esc.data?.items.map((e) => (
          <li key={e.escalationId} className="card">
            <p>{e.reason}</p>
            <span className="muted">{when(e.createdAt)}</span>
            <button onClick={() => act(`${base}/escalations/${e.escalationId}/resolve`)}>Опрацьовано</button>
          </li>
        ))}
      </ul>

      <h2>Чернетки замовлень</h2>
      <p className="row">
        {Object.entries(STATUS).map(([k, label]) => (
          <button key={k} className={status === k ? 'active' : ''} onClick={() => setStatus(k)}>
            {label}
          </button>
        ))}
      </p>
      {drafts.data?.items.length === 0 && <p className="muted">Порожньо.</p>}
      <ul className="cards">
        {drafts.data?.items.map((d) => (
          <li key={d.draftId} className="card">
            <strong>{money(d.totalMinor, d.currency)}</strong> <span className="muted">{when(d.createdAt)} · {d.createdBy === 'ai' ? 'створив ШІ' : 'створено вручну'}</span>
            <ul>
              {d.items.map((i) => (
                <li key={i.sku}>
                  {i.productName} {Object.values(i.options).join(' / ')} ({i.sku}) × {i.quantity} — {money(i.unitPriceMinor, d.currency)}
                </li>
              ))}
            </ul>
            <p>
              {d.contactName} {d.contactPhone}
              <br />
              {d.deliveryInfo}
              {d.note && <><br />{d.note}</>}
            </p>
            {d.status === 'pending_approval' && (
              <p className="row">
                <button onClick={() => act(`${base}/order-drafts/${d.draftId}/approve`, 'Підтвердити замовлення? Залишки на складі зменшаться.')}>Підтвердити</button>
                <button onClick={() => act(`${base}/order-drafts/${d.draftId}/reject`, 'Відхилити чернетку?')}>Відхилити</button>
              </p>
            )}
            {d.decisionNote && <p className="muted">{d.decisionNote}</p>}
          </li>
        ))}
      </ul>
    </>
  );
}
