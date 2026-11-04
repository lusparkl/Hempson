import { useEffect, useRef, useState } from 'react';
import { useShop } from '../App';
import { api, errText, money, moneyList, orderNo, shortWhen, token, useLoad, when } from '../api';
import { Alert, Avatar, Badge, Button, HeaderActions, Icon, useToast, type Tone } from '../ui';

type Item = { sku: string; productName: string; options: Record<string, string>; quantity: number; unitPriceMinor: number };
export type Draft = {
  draftId: string;
  /** Per-shop sequential number. */
  number: number;
  conversationId: string | null;
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
  checkout: { phone: string | null; cityName: string | null; branchName: string | null; paymentMethod: 'cod' | 'prepaid' | null; missing: string[] };
  payment: { dueAt: string | null; latest: { state: string; pageUrl: string | null; linkDelivery: string | null; providerErrCode: string | null; flag: string | null } | null } | null;
  delivery: { ttnState: 'creating' | 'created' | 'failed' | 'uncertain' | null; ttnError: string | null; ttn: string | null; statusText: string | null; statusAt: string | null };
  customerNotices: Array<{ event: string; state: string; code: string | null; at: string }>;
  items: Item[];
};

/** Status label and badge tone (design ST map plus the statuses the design does not show). */
export const STATUS: Record<string, [string, Tone]> = {
  pending_approval: ['Очікує', 'warning'],
  approved: ['Підтверджено', 'brand'],
  awaiting_payment: ['Чекає оплату', 'info'],
  cod_confirmed: ['Накладений платіж', 'brand'],
  paid: ['Оплачено', 'success'],
  shipped: ['Відправлено', 'info'],
  delivered: ['Отримано', 'success'],
  returning: ['Повертається', 'warning'],
  returned: ['Повернено', 'neutral'],
  rejected: ['Відхилено', 'danger'],
  cancelled: ['Скасовано', 'neutral'],
  refund_requested: ['Запит на повернення', 'warning'],
};
const GROUPS: Array<[string, string, string[] | null]> = [
  ['all', 'Усі', null],
  ['pending', 'Очікують', ['pending_approval']],
  ['payment', 'Чекають оплату', ['awaiting_payment']],
  ['ready', 'До відправки', ['approved', 'cod_confirmed', 'paid']],
  ['shipped', 'У дорозі', ['shipped', 'returning']],
  ['done', 'Завершені', ['delivered']],
  ['closed', 'Закриті', ['rejected', 'cancelled', 'returned', 'refund_requested']],
];
const RANK: Record<string, number> = { pending_approval: 0, approved: 1, awaiting_payment: 1, cod_confirmed: 1, paid: 2, shipped: 3, returning: 3, delivered: 4, returned: 3, refund_requested: 2 };
const PAY_STATE: Record<string, string> = {
  creating: 'посилання створюється…',
  create_failed: 'посилання не створено',
  created: 'посилання надіслано, оплати ще немає',
  processing: 'оплата обробляється',
  hold: 'кошти заблоковані',
  success: 'оплачено (підтвердив monobank)',
  failure: 'оплата не пройшла',
  reversed: 'оплату повернуто клієнту',
  expired: 'посилання прострочене',
  removed: 'посилання деактивоване',
};
const NOTICE: Record<string, string> = { confirmed: 'підтвердження', rejected: 'відхилення', paid: 'оплату отримано', shipped: 'відправлення (ТТН)', delivered: 'отримання' };
const NOTICE_WHY: Record<string, string> = { OUTSIDE_MESSAGING_WINDOW: '24-годинне вікно Instagram закрите', ACCOUNT_NOT_CONNECTED: 'канал не підключений' };
const MISSING: Record<string, string> = { 'recipient name': 'ім’я отримувача', phone: 'телефон', 'Nova Poshta city': 'місто', 'Nova Poshta branch': 'відділення Нової Пошти', 'payment method': 'спосіб оплати' };
const PAID = ['paid', 'shipped', 'delivered', 'returning', 'returned'];
const HELD = ['approved', 'awaiting_payment', 'cod_confirmed', 'paid'];

export function Orders() {
  const { shop, params, escalations, go, refresh } = useShop();
  const base = `/v1/shops/${shop.shopId}`;
  const say = useToast();
  const drafts = useLoad(() => api<{ total: number; items: Draft[] }>('GET', `${base}/order-drafts?limit=200`), [base], 8000);
  const [tab, setTab] = useState(params.tab ?? (params.draftId ? 'all' : 'pending'));
  const [sel, setSel] = useState<string | null>(params.draftId ?? null);
  const [busy, setBusy] = useState(false);

  const all = drafts.data?.items ?? [];
  const inGroup = (g: string) => {
    const st = GROUPS.find((x) => x[0] === g)?.[2];
    return st ? all.filter((d) => st.includes(d.status)) : all;
  };
  const rows = inGroup(tab);
  const d = rows.find((x) => x.draftId === sel) ?? rows[0] ?? null;

  const act = async (path: string, confirmText: string | null, ok: string, body: unknown = {}) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await api('POST', `${base}/order-drafts/${d!.draftId}/${path}`, body);
      say(ok);
      await drafts.reload();
      refresh();
    } catch (e) {
      say(errText(e), true);
    } finally {
      setBusy(false);
    }
  };
  const resolve = async (id: string) => {
    try {
      await api('POST', `${base}/escalations/${id}/resolve`, {});
      say('Позначено як опрацьоване');
      refresh();
    } catch (e) {
      say(errText(e), true);
    }
  };

  return (
    <div className="page">
      <HeaderActions>
        <ExportMenu base={base} />
      </HeaderActions>
      {escalations.map((e) => (
        <div key={e.escalationId} className="notice warning">
          <Icon name="hand" size={20} />
          <div>
            <strong style={{ fontWeight: 500 }}>Потрібна людина.</strong> {e.reason}
          </div>
          <Button variant="secondary" size="sm" onClick={() => go('inbox', { conversationId: e.conversationId })}>
            Відповісти
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void resolve(e.escalationId)}>
            Опрацьовано
          </Button>
        </div>
      ))}
      <div className="tabs" role="tablist">
        {GROUPS.map(([k, l]) => (
          <button key={k} className="tab" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {l}
            <span className="tab-count">{inGroup(k).length}</span>
          </button>
        ))}
      </div>
      {drafts.error && <div className="err">{drafts.error}</div>}
      <div className="split">
        <div className="panel clip">
          <div className="thead orders-cols">
            <span>Клієнт</span>
            <span>Сума</span>
            <span>Статус</span>
          </div>
          {rows.map((o) => {
            const [label, tone] = STATUS[o.status] ?? [o.status, 'neutral' as Tone];
            const name = o.contactName ?? 'Клієнт';
            return (
              <button key={o.draftId} className="orow" aria-current={d?.draftId === o.draftId} onClick={() => setSel(o.draftId)}>
                <span style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }}>
                  <Avatar name={name} seed={o.customerId} size={36} />
                  <span style={{ minWidth: 0 }}>
                    <span className="ellipsis" style={{ display: 'block', fontWeight: 500, color: 'var(--ink-900)' }}>
                      {name}
                    </span>
                    <span style={{ display: 'block', fontSize: 12 }} className="subtle">
                      {orderNo(o.number)} · {shortWhen(o.createdAt)}
                    </span>
                  </span>
                </span>
                <span style={{ fontWeight: 500, color: 'var(--ink-900)' }}>{moneyList(o.totalMinor, o.currency)}</span>
                <span>
                  <Badge tone={tone}>{label}</Badge>
                </span>
              </button>
            );
          })}
          {drafts.data && rows.length === 0 && <div className="panel-empty" style={{ padding: '48px 20px' }}>У цій категорії замовлень немає.</div>}
        </div>
        {d && <Detail d={d} busy={busy} act={act} />}
      </div>
    </div>
  );
}

function Detail({ d, busy, act }: { d: Draft; busy: boolean; act: (path: string, confirmText: string | null, ok: string, body?: unknown) => Promise<void> }) {
  const [label, tone] = STATUS[d.status] ?? [d.status, 'neutral' as Tone];
  const dead = d.status === 'rejected' || d.status === 'cancelled';
  const r = RANK[d.status] ?? 0;
  const prepaid = d.checkout.paymentMethod === 'prepaid';
  const steps = ['Створено', 'Підтверджено', prepaid ? 'Оплачено' : 'Накладений платіж', 'Відправлено', 'Отримано'];
  const pay = d.checkout.paymentMethod === 'cod' ? 'накладений платіж' : prepaid ? 'передоплата (monobank)' : '—';
  const delivery = [d.deliveryInfo ?? ([d.checkout.cityName, d.checkout.branchName].filter(Boolean).join(', ') || '—'), d.delivery.ttn ? `ТТН ${d.delivery.ttn}` : null].filter(Boolean).join(' · ');
  const missing = d.status === 'pending_approval' && d.checkout.missing.length > 0;
  const lp = d.payment?.latest;
  return (
    <div className="panel clip detail">
      <div className="detail-sec" style={{ gap: 6, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13 }} className="subtle">
            {orderNo(d.number)} · {shortWhen(d.createdAt)} · {d.createdBy === 'ai' ? 'створив ШІ' : 'вручну'}
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <Badge tone={tone}>{label}</Badge>
          </span>
        </div>
        <div className="detail-total">{money(d.totalMinor, d.currency)}</div>
      </div>
      <div className="detail-sec">
        <div className="eyebrow">Товари</div>
        {d.items.map((i) => (
          <div key={i.sku} style={{ display: 'flex', gap: 12, alignItems: 'baseline', fontSize: 15 }}>
            <span style={{ flex: 1, color: 'var(--ink-900)' }}>
              {i.productName}
              {Object.values(i.options).length ? ` · ${Object.values(i.options).join(' / ')}` : ''} <span className="subtle">× {i.quantity}</span>
              <span className="mono subtle" style={{ display: 'block', fontSize: 12 }}>
                {i.sku}
              </span>
            </span>
            <span style={{ color: 'var(--ink-800)' }}>{money(i.unitPriceMinor * i.quantity, d.currency)}</span>
          </div>
        ))}
      </div>
      <div className="detail-sec kv" style={{ display: 'grid' }}>
        <div>
          <div className="eyebrow">Клієнт</div>
          <div className="kv-val">
            {d.contactName ?? '—'}
            <br />
            {d.checkout.phone ?? d.contactPhone ?? '—'}
          </div>
        </div>
        <div>
          <div className="eyebrow">Доставка й оплата</div>
          <div className="kv-val">
            {delivery}
            <br />
            Оплата: {pay}
          </div>
        </div>
        {d.note && (
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="eyebrow">Примітка</div>
            <div className="kv-val">{d.note}</div>
          </div>
        )}
      </div>
      <div style={{ padding: '16px 20px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {missing && <Alert>Бракує даних для підтвердження: {d.checkout.missing.map((m) => MISSING[m] ?? m).join(', ')}</Alert>}
        {d.delivery.statusText && (
          <Alert tone="info" icon="truck">
            {d.delivery.statusText} ({when(d.delivery.statusAt)})
          </Alert>
        )}
        {d.payment && (
          <Alert tone={lp?.flag || lp?.state === 'failure' || lp?.state === 'create_failed' ? 'danger' : 'info'} icon="credit-card">
            Оплата monobank: {lp ? (PAY_STATE[lp.state] ?? lp.state) : 'посилання ще немає'}
            {lp?.providerErrCode && <> (код {lp.providerErrCode})</>}
            {d.status === 'awaiting_payment' && d.payment.dueAt && <> · до {when(d.payment.dueAt)}</>}
            {lp?.pageUrl && d.status === 'awaiting_payment' && (
              <>
                <br />
                <a href={lp.pageUrl} target="_blank" rel="noreferrer">
                  {lp.pageUrl}
                </a>
              </>
            )}
            {lp?.linkDelivery && lp.linkDelivery !== 'sent' && d.status === 'awaiting_payment' && <><br />Посилання не дійшло до клієнта, передайте його інакше.</>}
            {lp?.flag === 'AMOUNT_MISMATCH' && <><br />Сума оплати не збігається із замовленням. Перевірте кабінет monobank.</>}
            {lp?.flag === 'PAID_AFTER_CANCEL' && <><br />Оплата надійшла після скасування. Поверніть кошти в кабінеті monobank, якщо потрібно.</>}
          </Alert>
        )}
        {d.customerNotices
          .filter((n) => n.state === 'failed' || n.state === 'uncertain')
          .map((n) => (
            <Alert key={n.event} tone="warning">
              {n.state === 'failed' ? 'Повідомлення клієнту не дійшло' : 'Невідомо, чи дійшло повідомлення клієнту'}: {NOTICE[n.event] ?? n.event}
              {n.code && <> ({NOTICE_WHY[n.code] ?? n.code})</>}. Повідомте клієнта інакше, якщо потрібно.
            </Alert>
          ))}
        {d.delivery.ttnState === 'creating' && <Alert tone="info" icon="truck">ТТН створюється…</Alert>}
        {d.delivery.ttnState === 'failed' && <Alert>ТТН не створено ({d.delivery.ttnError}).</Alert>}
        {d.delivery.ttnState === 'uncertain' && <Alert>Нова Пошта не відповіла під час створення ТТН. Перевірте кабінет НП: якщо накладної немає, дозвольте нову спробу.</Alert>}
        {d.decisionNote && <div style={{ fontSize: 13 }} className="subtle">{d.decisionNote}</div>}
      </div>
      <div style={{ padding: '16px 20px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="steps">
          {steps.map((t, i) => {
            const on = i === 0 || (!dead && r >= i);
            return (
              <div key={t}>
                <div className={`step-bar${on ? ' on' : ''}`} />
                <div className={`step-lbl${on ? ' on' : ''}`}>{t}</div>
              </div>
            );
          })}
        </div>
        <div className="actions">
          {d.status === 'pending_approval' && (
            <>
              <Button variant="primary" size="md" disabled={busy} onClick={() => void act('approve', 'Підтвердити замовлення? Залишки на складі зменшаться.', `Замовлення ${orderNo(d.number)} підтверджено`)}>
                Підтвердити
              </Button>
              <Button variant="secondary" size="md" disabled={busy} onClick={() => void act('reject', 'Відхилити чернетку?', `Замовлення ${orderNo(d.number)} відхилено`)}>
                Відхилити
              </Button>
            </>
          )}
          {(d.status === 'cod_confirmed' || d.status === 'paid') && (d.delivery.ttnState === null || d.delivery.ttnState === 'failed') && (
            <Button variant="primary" size="md" icon="truck" disabled={busy} onClick={() => void act('ttn', null, 'ТТН створюється')}>
              Створити ТТН
            </Button>
          )}
          {d.status === 'awaiting_payment' && (!lp || ['create_failed', 'failure', 'expired'].includes(lp.state)) && (
            <Button variant="primary" size="md" icon="credit-card" disabled={busy} onClick={() => void act('payment-link', null, 'Посилання на оплату створюється')}>
              Створити посилання на оплату
            </Button>
          )}
          {d.delivery.ttnState === 'uncertain' && (
            <Button variant="secondary" size="md" disabled={busy} onClick={() => void act('ttn/release', 'Ви перевірили кабінет Нової Пошти і накладної для цього замовлення немає?', 'Можна створити ТТН знову')}>
              Накладної немає, спробувати знову
            </Button>
          )}
          {d.status === 'returning' && (
            <>
              <Button variant="primary" size="md" disabled={busy} onClick={() => void act('returned', 'Посилка вже у вас? Товар повернеться на склад.', 'Повернення зараховано')}>
                Повернено
              </Button>
              <Button variant="secondary" size="md" disabled={busy} onClick={() => void act('returned', 'Посилка у вас, але товар не повертається на склад (пошкоджений)?', 'Повернення зараховано', { restock: false })}>
                Повернено без повернення на склад
              </Button>
            </>
          )}
          {PAID.includes(d.status) && (
            <Button variant="secondary" size="md" disabled={busy} onClick={() => void act('refund-requested', 'Записати запит клієнта на повернення коштів? Самі кошти повертаються в кабінеті monobank.', 'Запит на повернення записано')}>
              Запит на повернення коштів
            </Button>
          )}
          {HELD.includes(d.status) && d.delivery.ttnState !== 'creating' && d.delivery.ttnState !== 'uncertain' && (
            <Button variant="secondary" size="md" disabled={busy} onClick={() => void act('cancel', 'Скасувати замовлення? Товар повернеться на склад.', 'Замовлення скасовано')}>
              Скасувати
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** "Експорт Excel" with a 30 / 90 / 365-day menu. The session token cannot ride on a plain link, so it fetches and saves the blob. */
function ExportMenu({ base }: { base: string }) {
  const [open, setOpen] = useState(false);
  const say = useToast();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const run = async (days: number) => {
    setOpen(false);
    say(`Експорт Excel за ${days} днів розпочато`);
    const from = new Date(Date.now() - days * 86_400_000).toISOString();
    try {
      const res = await fetch(`${base}/order-drafts/export.xlsx?from=${encodeURIComponent(from)}`, { headers: { authorization: `Bearer ${token.get() ?? ''}` } });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? res.statusText);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'orders.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      say(errText(e), true);
    }
  };
  return (
    <div style={{ position: 'relative' }} ref={box}>
      <Button variant="secondary" size="sm" icon="download" onClick={() => setOpen(!open)} aria-expanded={open}>
        Експорт Excel
      </Button>
      {open && (
        <div className="menu" role="menu">
          {[30, 90, 365].map((n) => (
            <button key={n} role="menuitem" onClick={() => void run(n)}>
              Excel за {n} днів
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
