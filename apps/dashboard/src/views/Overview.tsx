import { useShop } from '../App';
import { ago, api, customerName, dayText, moneyShort, orderNo, preview, revenue, statsUrl, useLoad, type Conv, type StatsData } from '../api';
import { Avatar, Button, FunnelRows, Icon, Panel, Spark, type IconName } from '../ui';
import { channelLabel } from './Inbox';

type DraftLite = { draftId: string; number: number; conversationId: string | null; totalMinor: number; currency: string; contactName: string | null; createdBy: string; checkout: { missing: string[] } };
type ProductLite = { variants: Array<{ stock: number; active: boolean }>; active: boolean };

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Доброї ночі' : h < 12 ? 'Доброго ранку' : h < 18 ? 'Доброго дня' : 'Доброго вечора';
};
const tile = (bg: string, fg: string) => ({ background: bg, color: fg });

export function Overview() {
  const { shop, me, go, escalations } = useShop();
  const base = `/v1/shops/${shop.shopId}`;
  const cur = useLoad(() => api<StatsData>('GET', statsUrl(shop.shopId, 30)), [shop.shopId], 60_000);
  const prev = useLoad(() => api<StatsData>('GET', statsUrl(shop.shopId, 30, 30)), [shop.shopId]);
  const pend = useLoad(() => api<{ total: number; items: DraftLite[] }>('GET', `${base}/order-drafts?status=pending_approval&limit=3`), [base], 8000);
  const prods = useLoad(() => api<{ items: ProductLite[] }>('GET', `${base}/products?limit=200`), [base]);
  const convs = useLoad(() => api<{ items: Conv[] }>('GET', `${base}/conversations?limit=4`), [base], 10_000);

  const s = cur.data;
  const p = prev.data;
  const delta = (a: number, b: number | undefined, pct: boolean) => {
    if (b === undefined) return null;
    if (pct) {
      if (!b) return null;
      const v = Math.round(((a - b) / b) * 100);
      return { text: `${v >= 0 ? '+' : ''}${v}%`, up: v >= 0 };
    }
    const v = a - b;
    return { text: `${v >= 0 ? '+' : ''}${v}`, up: v >= 0 };
  };
  const series = (pick: (d: StatsData['daily'][number]) => number) => s?.daily.map(pick) ?? null;
  const rev = s ? revenue(s, shop.defaultCurrency) : null;
  const kpis = s
    ? [
        { label: 'Відповіді ШІ', value: String(s.messages.outgoingAi), spark: series((d) => d.replied), sub: `із ${s.ai.runs} запусків${s.ai.replyRate === null ? '' : ` · ${Math.round(s.ai.replyRate * 100)}%`}`, d: delta(s.messages.outgoingAi, p?.messages.outgoingAi, true) },
        { label: 'Нові клієнти', value: String(s.conversations.newCustomers), spark: series((d) => d.newCustomers), sub: 'за 30 днів', d: delta(s.conversations.newCustomers, p?.conversations.newCustomers, false) },
        { label: 'Підтверджені замовлення', value: String(s.funnel.approved), spark: series((d) => d.approved), sub: `${s.orderSources.approved.ai} від ШІ · ${s.orderSources.approved.human} від менеджера`, d: delta(s.funnel.approved, p?.funnel.approved, false) },
        // The daily revenue series is in the shop currency; another currency has no series.
        { label: 'Виручка', value: moneyShort(rev!.totalMinor, rev!.currency), spark: rev!.currency === s.currency ? series((d) => d.revenueMinor) : null, sub: 'підтверджені замовлення', d: p ? delta(rev!.totalMinor, revenue(p, shop.defaultCurrency).totalMinor, true) : null },
      ]
    : [];

  type Task = { key: string; icon: IconName; title: string; sub: string; tile: { background: string; color: string }; cta: string; go: () => void };
  const tasks: Task[] = [];
  for (const e of escalations.slice(0, 3))
    tasks.push({ key: e.escalationId, icon: 'hand', title: 'Потрібна людина', sub: e.reason, tile: tile('var(--warning-bg)', 'var(--warning-fg)'), cta: 'Відповісти', go: () => go('inbox', { conversationId: e.conversationId }) });
  for (const d of pend.data?.items ?? [])
    tasks.push({
      key: d.draftId,
      icon: 'shopping-bag',
      title: `Чернетка ${orderNo(d.number)} · ${moneyShort(d.totalMinor, d.currency)}`,
      sub: `${d.contactName ?? 'Клієнт'} · ${d.createdBy === 'ai' ? 'створив ШІ' : 'вручну'}${d.checkout.missing.length ? ' · бракує даних' : ''}`,
      tile: tile('var(--brand-50)', 'var(--brand-700)'),
      cta: 'Переглянути',
      go: () => go('orders', { tab: 'pending', draftId: d.draftId }),
    });
  const low = (prods.data?.items ?? []).flatMap((x) => (x.active ? x.variants.filter((v) => v.active && v.stock > 0 && v.stock < 5) : [])).length;
  if (low)
    tasks.push({ key: 'low', icon: 'package', title: 'Закінчується залишок', sub: `${low} варіант(и) товару мають менше 5 шт.`, tile: tile('var(--info-bg)', 'var(--info-fg)'), cta: 'До каталогу', go: () => go('catalog', { stock: 'low' }) });

  const first = (me?.displayName ?? '').split(' ')[0];
  return (
    <div className="page">
      <div className="greet">
        <h2>
          {greeting()}
          {first ? `, ${first}` : ''}
        </h2>
        <p>Ось що відбувається в «{shop.name}» сьогодні.</p>
      </div>
      {cur.error && <div className="err">{cur.error}</div>}
      {s?.usage.paidUntil && s.usage.paidDaysLeft !== null && s.usage.paidDaysLeft <= 7 && (
        <div className="notice warning">
          <Icon name="circle-alert" size={20} />
          <div>
            {s.usage.planExpired
              ? `Оплачений період закінчився ${dayText(s.usage.paidUntil)}: ШІ не відповідає, нові розмови передаються людям. Щоб продовжити, зверніться до Hepson.`
              : `Сервіс оплачено до ${dayText(s.usage.paidUntil)} включно. Після цієї дати ШІ перестане відповідати клієнтам. Щоб продовжити, зверніться до Hepson.`}
          </div>
        </div>
      )}
      {s?.usage.capReached && (
        <div className="notice warning">
          <Icon name="circle-alert" size={20} />
          <div>Ліміт відповідей ШІ на цей місяць вичерпано: до кінця місяця нові розмови передаються людям.</div>
        </div>
      )}
      <div className="kpis">
        {kpis.map((k) => (
          <div key={k.label} className="kpi">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="kpi-label">{k.label}</span>
              {k.d && (
                <span className="kpi-delta" style={{ color: k.d.up ? 'var(--success-fg)' : 'var(--danger-fg)' }} title="порівняно з попередніми 30 днями">
                  {k.d.text}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, minWidth: 0 }}>
              <div className="kpi-value">{k.value}</div>
              <Spark data={k.spark} />
            </div>
            <div className="kpi-sub">{k.sub}</div>
          </div>
        ))}
      </div>
      <div className="cols">
        <div className="stack">
          <Panel title="Потребують уваги" meta={tasks.length ? `${tasks.length} задач` : ''} clip>
            {tasks.map((a) => (
              <div key={a.key} className="task">
                <span className="task-tile" style={a.tile}>
                  <Icon name={a.icon} size={18} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="task-title">{a.title}</div>
                  <div className="task-sub">{a.sub}</div>
                </div>
                <Button variant="secondary" size="sm" onClick={a.go}>
                  {a.cta}
                </Button>
              </div>
            ))}
            {tasks.length === 0 && <div className="panel-empty">Усе опрацьовано — нічого не чекає на вас.</div>}
          </Panel>
          <Panel title="Воронка продажів" meta="за 30 днів">
            {s && (
              <FunnelRows
                rows={[
                  { label: 'Розмови з повідомленням клієнта', value: s.funnel.conversations },
                  { label: 'Чернетки замовлень', value: s.funnel.drafts },
                  { label: 'Підтверджено', value: s.funnel.approved },
                  { label: 'Оплачено (передоплата)', value: s.funnel.paid },
                  { label: 'Відправлено', value: s.funnel.shipped },
                ]}
              />
            )}
          </Panel>
        </div>
        <Panel
          title="Останні розмови"
          clip
          action={
            <Button variant="secondary" size="sm" onClick={() => go('inbox')}>
              Усі
            </Button>
          }
        >
          {convs.data?.items.map((c) => (
            <button key={c.conversationId} className="conv-row" onClick={() => go('inbox', { conversationId: c.conversationId })}>
              <Avatar name={customerName(c.customer)} seed={c.conversationId} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <strong style={{ fontWeight: 500, color: 'var(--ink-900)' }}>{customerName(c.customer)}</strong>
                  <span style={{ fontSize: 12 }} className="subtle">
                    {channelLabel(c.channel)} · {ago(c.lastMessageAt)}
                  </span>
                </div>
                <div className="ellipsis muted" style={{ fontSize: 14, ...(c.unread ? { color: 'var(--ink-900)' } : {}) }}>
                  {preview(c.lastMessage)}
                </div>
              </div>
            </button>
          ))}
          {convs.data?.items.length === 0 && <div className="panel-empty">Розмов ще немає. Підключіть канал у Налаштуваннях.</div>}
        </Panel>
      </div>
    </div>
  );
}
