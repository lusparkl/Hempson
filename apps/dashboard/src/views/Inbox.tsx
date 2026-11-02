import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useShop } from '../App';
import { ago, api, customerName, dateOnly, errText, hhmm, money, useLoad, type Conv } from '../api';
import { Avatar, Badge, Button, Icon, Switch, Textarea, useToast, type IconName } from '../ui';
import { STATUS, type Draft } from './Orders';

type Msg = { messageId: string; direction: 'incoming' | 'outgoing'; senderType: 'customer' | 'ai' | 'human' | 'system'; text: string | null; deliveryStatus: string; deliveryError: string | null; occurredAt: string };

const CH: Record<string, [string, IconName]> = { instagram: ['Instagram', 'instagram'], 'instagram-official': ['Instagram', 'instagram'], telegram: ['Telegram', 'send'], website: ['Чат на сайті', 'globe'] };
export const channelLabel = (ch: string) => CH[ch]?.[0] ?? ch;
const channelIcon = (ch: string): IconName => CH[ch]?.[1] ?? 'message-circle';

type Filter = 'all' | 'needs' | 'paused';

export function Inbox() {
  const { shop, params, escalations, refresh } = useShop();
  const base = `/v1/shops/${shop.shopId}`;
  const list = useLoad(() => api<{ items: Conv[] }>('GET', `${base}/conversations?limit=200`), [base], 5000);
  const [sel, setSel] = useState<string | null>(params.conversationId ?? null);
  const [q, setQ] = useState('');
  const [f, setF] = useState<Filter>('all');
  const needs = new Set(escalations.map((e) => e.conversationId));
  const all = list.data?.items ?? [];
  const term = q.trim().toLowerCase();
  const rows = all.filter(
    (c) =>
      (f === 'all' || (f === 'needs' && needs.has(c.conversationId)) || (f === 'paused' && c.aiPaused)) &&
      (!term || `${c.customer.displayName ?? ''} ${c.customer.handle ?? ''}`.toLowerCase().includes(term)),
  );
  const conv = all.find((c) => c.conversationId === sel) ?? null;
  // As in the design, a wide screen opens on the first conversation; on phones the list stays first.
  const first = all[0]?.conversationId;
  useEffect(() => {
    if (!sel && first && window.matchMedia('(min-width: 721px)').matches) setSel(first);
  }, [sel, first]);
  const filters: Array<[Filter, string, number]> = [
    ['all', 'Усі', all.length],
    ['needs', 'Потрібна людина', all.filter((c) => needs.has(c.conversationId)).length],
    ['paused', 'ШІ на паузі', all.filter((c) => c.aiPaused).length],
  ];

  return (
    <div className="inbox" data-open={conv ? '' : undefined}>
      <section className="inbox-list" aria-label="Розмови">
        <div className="inbox-tools">
          <div className="search">
            <Icon name="search" size={16} />
            <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Пошук розмов" aria-label="Пошук розмов" />
          </div>
          <div className="pills">
            {filters.map(([k, l, n]) => (
              <button key={k} className="pill" aria-pressed={f === k} onClick={() => setF(k)}>
                {l} · {n}
              </button>
            ))}
          </div>
        </div>
        <div className="scroll">
          {list.error && <div className="panel-empty err">{list.error}</div>}
          {rows.map((c) => {
            const need = needs.has(c.conversationId);
            const name = customerName(c.customer);
            return (
              <button key={c.conversationId} className="conv" aria-current={c.conversationId === sel} onClick={() => setSel(c.conversationId)}>
                <Avatar name={name} seed={c.conversationId} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <strong className="ellipsis" style={{ fontWeight: 500, color: 'var(--ink-900)', flex: 1 }}>
                      {name}
                    </strong>
                    <span style={{ fontSize: 12 }} className="subtle">
                      {ago(c.lastMessageAt)}
                    </span>
                  </div>
                  {/* P10: last-message preview; until then the line shows who is handling the chat. */}
                  <div className="ellipsis muted" style={{ fontSize: 14, marginTop: 2 }}>
                    {c.aiPaused ? 'Розмову веде людина' : 'ШІ відповідає'}
                  </div>
                  <div className="conv-meta">
                    <Icon name={channelIcon(c.channel)} size={13} />
                    {channelLabel(c.channel)}
                    {need ? <span className="tag warn">Потрібна людина</span> : c.aiPaused ? <span className="tag paused">ШІ на паузі</span> : null}
                  </div>
                </div>
                {/* P10: real unread state; until then the dot marks an open hand-off. */}
                {need && <span className="unread" />}
              </button>
            );
          })}
          {list.data && rows.length === 0 && <div className="placeholder">{all.length ? 'Нічого не знайдено' : 'Розмов ще немає'}</div>}
        </div>
      </section>
      {conv ? (
        <Thread
          key={conv.conversationId}
          base={base}
          conv={conv}
          onBack={() => setSel(null)}
          onChange={() => {
            void list.reload();
            refresh();
          }}
        />
      ) : (
        <section className="thread">
          <div className="placeholder">Оберіть розмову зліва.</div>
        </section>
      )}
      {conv && <Side base={base} conv={conv} />}
    </div>
  );
}

function Thread({ base, conv, onBack, onChange }: { base: string; conv: Conv; onBack: () => void; onChange: () => void }) {
  const { go } = useShop();
  const say = useToast();
  const url = `${base}/conversations/${conv.conversationId}`;
  const msgs = useLoad(() => api<{ items: Msg[] }>('GET', `${url}/messages?limit=200`), [url], 4000);
  const drafts = useLoad(() => api<{ items: Draft[] }>('GET', `${base}/order-drafts?conversationId=${conv.conversationId}&limit=20`), [url], 8000);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const name = customerName(conv.customer);
  const count = msgs.data?.items.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  const toggleAi = async () => {
    try {
      await api('PUT', `${url}/ai`, { paused: !conv.aiPaused });
      say(conv.aiPaused ? 'ШІ знову відповідає в цій розмові' : 'ШІ на паузі · розмову веде людина');
      onChange();
    } catch (e) {
      say(errText(e), true);
    }
  };
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = reply.trim();
    if (!text) return;
    setBusy(true);
    try {
      await api('POST', `${url}/messages`, { text });
      setReply('');
      await msgs.reload();
      say('Відповідь надіслано · ШІ призупинено');
      onChange();
    } catch (x) {
      say(errText(x), true);
    } finally {
      setBusy(false);
    }
  };

  // Messages and this conversation's order drafts, in time order, with a date chip at each new day.
  type Item = { at: string; m?: Msg; d?: Draft };
  const items: Item[] = [...(msgs.data?.items ?? []).map((m) => ({ at: m.occurredAt, m })), ...(drafts.data?.items ?? []).map((d) => ({ at: d.createdAt, d }))].sort((a, b) => a.at.localeCompare(b.at));
  let lastDay = '';

  return (
    <section className="thread">
      <div className="thread-head">
        <button className="iconbtn back" onClick={onBack} aria-label="До списку">
          <Icon name="chevron-left" size={18} />
        </button>
        <Avatar name={name} seed={conv.conversationId} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ellipsis" style={{ fontWeight: 500, color: 'var(--ink-900)' }}>
            {name}
          </div>
          <div style={{ fontSize: 13 }} className="subtle">
            {channelLabel(conv.channel)} · {conv.aiPaused ? 'Розмову веде людина' : 'ШІ відповідає'}
          </div>
        </div>
        <Switch label="ШІ відповідає" checked={!conv.aiPaused} onChange={() => void toggleAi()} />
      </div>
      <div className="msgs">
        {msgs.error && <div className="err">{msgs.error}</div>}
        {items.map((it) => {
          const day = dateOnly(it.at);
          const chip = day !== lastDay ? <div className="day">{new Date(it.at).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' })}</div> : null;
          lastDay = day;
          if (it.d) {
            const d = it.d;
            const [label, tone] = STATUS[d.status] ?? [d.status, 'neutral'];
            return (
              <div key={d.draftId} style={{ display: 'contents' }}>
                {chip}
                <div className="sys">
                  <Icon name="sparkles" size={14} />
                  {d.createdBy === 'ai' ? 'ШІ створив чернетку замовлення' : 'Створено чернетку замовлення'}
                </div>
                <div className="draft-card">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12 }} className="subtle">
                        Чернетка замовлення · {d.createdBy === 'ai' ? 'створив ШІ' : 'вручну'}
                      </div>
                      <div className="amount">{money(d.totalMinor, d.currency)}</div>
                    </div>
                    <Badge tone={tone}>{label}</Badge>
                  </div>
                  <div style={{ fontSize: 14, lineHeight: 1.5 }} className="muted">
                    {d.items.map((i) => (
                      <div key={i.sku}>
                        {i.productName}
                        {Object.values(i.options).length ? ` · ${Object.values(i.options).join(' / ')}` : ''} × {i.quantity}
                      </div>
                    ))}
                    {(d.deliveryInfo || d.checkout.paymentMethod) && (
                      <div>
                        {[d.deliveryInfo, d.checkout.paymentMethod === 'cod' ? 'накладений платіж' : d.checkout.paymentMethod === 'prepaid' ? 'передоплата' : null].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                  <Button variant="primary" size="sm" onClick={() => go('orders', { draftId: d.draftId, tab: 'all' })}>
                    Перейти до замовлення
                  </Button>
                </div>
              </div>
            );
          }
          const m = it.m!;
          if (m.senderType === 'system')
            return (
              <div key={m.messageId} style={{ display: 'contents' }}>
                {chip}
                <div className="sys">
                  <Icon name="sparkles" size={14} />
                  {m.text}
                </div>
              </div>
            );
          const out = m.direction === 'outgoing';
          const kind = !out ? 'in' : m.senderType === 'ai' ? 'ai' : 'human';
          const status = m.deliveryStatus === 'failed' ? ` · не надіслано (${m.deliveryError ?? '?'})` : m.deliveryStatus === 'uncertain' ? ' · невідомо, чи надіслано' : m.deliveryStatus === 'pending' ? ' · надсилається' : '';
          return (
            <div key={m.messageId} style={{ display: 'contents' }}>
              {chip}
              <div className={`msg${out ? ' out' : ''}`}>
                <div className="msg-who">
                  {kind === 'in' ? name : kind === 'ai' ? 'ШІ-асистент' : 'Менеджер'}
                  {status && <span className="err">{status}</span>}
                </div>
                <div className={`bubble ${kind}`}>
                  {m.text}
                  <div className="bubble-time">{hhmm(m.occurredAt)}</div>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>
      <div className="composer">
        <form onSubmit={(e) => void send(e)}>
          <input className="field" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Відповісти клієнту…" maxLength={1000} autoComplete="off" aria-label="Відповідь клієнту" />
          <Button variant="primary" size="md" type="submit" disabled={busy}>
            Надіслати <Icon name="send" size={16} />
          </Button>
        </form>
        <div style={{ fontSize: 12 }} className="subtle">
          Ваша відповідь автоматично призупиняє ШІ в цій розмові.
        </div>
      </div>
    </section>
  );
}

function Side({ base, conv }: { base: string; conv: Conv }) {
  const drafts = useLoad(() => api<{ items: Draft[] }>('GET', `${base}/order-drafts?conversationId=${conv.conversationId}&limit=20`), [conv.conversationId], 15_000);
  const name = customerName(conv.customer);
  const ds = drafts.data?.items ?? [];
  // P10: customer-level phone, city and order history; until then from this conversation's latest draft.
  const latest = ds[0];
  const phone = latest?.checkout.phone ?? latest?.contactPhone ?? null;
  const city = latest?.checkout.cityName ?? null;
  const cur = latest?.currency ?? '';
  const sum = ds.filter((d) => !['rejected', 'cancelled'].includes(d.status)).reduce((a, d) => a + d.totalMinor, 0);
  return (
    <aside className="inbox-side" aria-label="Клієнт">
      <div className="profile">
        <Avatar name={name} size={56} fontSize={20} />
        <div style={{ fontSize: 17, fontWeight: 500, color: 'var(--ink-900)' }}>{name}</div>
        <div style={{ fontSize: 13 }} className="subtle">
          {channelLabel(conv.channel)}
          {conv.customer.handle && conv.customer.displayName ? ` · @${conv.customer.handle.replace(/^@/, '')}` : ''}
        </div>
      </div>
      <div className="facts">
        <div>
          <Icon name="phone" size={16} />
          {phone ?? 'не вказано'}
        </div>
        <div>
          <Icon name="map-pin" size={16} />
          {city ?? 'не вказано'}
        </div>
        <div>
          <Icon name="clock" size={16} />
          Перше звернення: {dateOnly(conv.customer.createdAt)}
        </div>
      </div>
      <div className="side-block">
        <div className="eyebrow">Замовлення</div>
        <div style={{ fontSize: 14 }} className="muted">
          {ds.length === 0 ? 'Замовлень ще немає' : ds.length === 1 ? `${STATUS[latest!.status]?.[0] ?? latest!.status} · ${money(latest!.totalMinor, cur)}` : `${ds.length} замовлення · ${money(sum, cur)}`}
        </div>
      </div>
      <div className="side-block">
        <div className="eyebrow">Нотатка</div>
        {/* P10: customer notes (no storage yet). */}
        <Textarea rows={4} placeholder="Додайте нотатку про клієнта…" disabled aria-label="Нотатка" />
        <div style={{ fontSize: 12 }} className="subtle">
          Нотатки про клієнтів з’являться незабаром.
        </div>
      </div>
    </aside>
  );
}
