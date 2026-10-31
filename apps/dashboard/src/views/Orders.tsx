import { useState } from 'react';
import { api, errText, money, useLoad, when, type Shop } from '../api';

type Item = { sku: string; productName: string; options: Record<string, string>; quantity: number; unitPriceMinor: number };
type Draft = {
  draftId: string;
  customerId: string;
  status: string;
  createdBy: string;
  contactName: string | null;
  contactPhone: string | null;
  deliveryInfo: string | null;
  note: string | null;
  currency: string;
  totalMinor: number;
  createdAt: string;
  decisionNote: string | null;
  checkout: { paymentMethod: 'cod' | 'prepaid' | null; missing: string[] };
  delivery: { ttnState: 'creating' | 'created' | 'failed' | 'uncertain' | null; ttnError: string | null; ttn: string | null; statusText: string | null; statusAt: string | null };
  items: Item[];
};
type Esc = { escalationId: string; conversationId: string; reason: string; createdAt: string };
const STATUS: Record<string, string> = {
  pending_approval: 'Очікують',
  cod_confirmed: 'Накладений платіж',
  awaiting_payment: 'Чекають оплату',
  shipped: 'Відправлені',
  delivered: 'Отримані',
  returning: 'Повертаються',
  returned: 'Повернені',
  rejected: 'Відхилені',
  cancelled: 'Скасовані',
};
const PAY: Record<string, string> = { cod: 'накладений платіж', prepaid: 'передоплата' };
const HELD = ['approved', 'awaiting_payment', 'cod_confirmed', 'paid'];

export function Orders({ shop }: { shop: Shop }) {
  const base = `/v1/shops/${shop.shopId}`;
  const [status, setStatus] = useState('pending_approval');
  const drafts = useLoad(() => api<{ items: Draft[] }>('GET', `${base}/order-drafts?status=${status}&limit=100`), [shop.shopId, status], 8000);
  const esc = useLoad(() => api<{ items: Esc[] }>('GET', `${base}/escalations?status=open`), [shop.shopId], 8000);
  const [err, setErr] = useState<string | null>(null);

  const act = async (path: string, confirmText?: string, body: unknown = {}) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setErr(null);
    try {
      await api('POST', path, body);
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

      <h2>Замовлення</h2>
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
              {d.checkout.paymentMethod && <><br />Оплата: {PAY[d.checkout.paymentMethod]}</>}
              {d.note && <><br />{d.note}</>}
            </p>
            {d.checkout.missing.length > 0 && d.status === 'pending_approval' && <p className="error">Бракує даних для підтвердження: {d.checkout.missing.join(', ')}</p>}
            {d.delivery.ttn && (
              <p>
                ТТН {d.delivery.ttn}
                {d.delivery.statusText && <> · {d.delivery.statusText} <span className="muted">({when(d.delivery.statusAt)})</span></>}
              </p>
            )}
            {d.delivery.ttnState === 'creating' && <p className="muted">ТТН створюється…</p>}
            {d.delivery.ttnState === 'failed' && <p className="error">ТТН не створено ({d.delivery.ttnError}).</p>}
            {d.delivery.ttnState === 'uncertain' && <p className="error">Нова Пошта не відповіла під час створення ТТН. Перевірте кабінет НП: якщо накладної немає, дозвольте нову спробу.</p>}
            <p className="row">
              {d.status === 'pending_approval' && (
                <>
                  <button onClick={() => act(`${base}/order-drafts/${d.draftId}/approve`, 'Підтвердити замовлення? Залишки на складі зменшаться.')}>Підтвердити</button>
                  <button onClick={() => act(`${base}/order-drafts/${d.draftId}/reject`, 'Відхилити чернетку?')}>Відхилити</button>
                </>
              )}
              {d.status === 'cod_confirmed' && (d.delivery.ttnState === null || d.delivery.ttnState === 'failed') && <button onClick={() => act(`${base}/order-drafts/${d.draftId}/ttn`)}>Створити ТТН</button>}
              {d.delivery.ttnState === 'uncertain' && <button onClick={() => act(`${base}/order-drafts/${d.draftId}/ttn/release`, 'Ви перевірили кабінет Нової Пошти і накладної для цього замовлення немає?')}>Накладної немає, спробувати знову</button>}
              {HELD.includes(d.status) && d.delivery.ttnState !== 'creating' && d.delivery.ttnState !== 'uncertain' && (
                <button onClick={() => act(`${base}/order-drafts/${d.draftId}/cancel`, 'Скасувати замовлення? Товар повернеться на склад.')}>Скасувати</button>
              )}
              {d.status === 'returning' && (
                <>
                  <button onClick={() => act(`${base}/order-drafts/${d.draftId}/returned`, 'Посилка вже у вас? Товар повернеться на склад.')}>Повернено</button>
                  <button onClick={() => act(`${base}/order-drafts/${d.draftId}/returned`, 'Посилка у вас, але товар не повертається на склад (пошкоджений)?', { restock: false })}>Повернено без повернення на склад</button>
                </>
              )}
            </p>
            {d.decisionNote && <p className="muted">{d.decisionNote}</p>}
          </li>
        ))}
      </ul>
    </>
  );
}
