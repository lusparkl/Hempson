import { useEffect, useRef, useState } from 'react';
import type { NavParams, Page } from './App';
import { ago, api, errText, moneyShort, orderNo, useLoad, type Feed, type FeedItem } from './api';
import { Icon, useToast, type IconName } from './ui';

const PAY: Record<string, string> = {
  create_failed: 'посилання не створено',
  failure: 'оплата не пройшла',
  reversed: 'оплату повернуто клієнту',
  expired: 'посилання прострочене',
};
const FLAG: Record<string, string> = { AMOUNT_MISMATCH: 'сума оплати не збігається', PAID_AFTER_CANCEL: 'оплата за скасоване замовлення' };

type Row = { icon: IconName; tone: string; title: string; sub: string; page: Page; params: NavParams };
function row(i: FeedItem): Row {
  const who = ('customer' in i && i.customer) || 'Клієнт';
  switch (i.kind) {
    case 'handoff':
      return {
        icon: 'hand',
        tone: 'warning',
        title: i.resolved ? 'Потрібна людина · опрацьовано' : 'Потрібна людина',
        sub: `${who}: ${i.reason}`,
        page: 'inbox',
        params: { conversationId: i.conversationId },
      };
    case 'order_new':
      return {
        icon: 'shopping-bag',
        tone: 'brand',
        title: `Нове замовлення ${orderNo(i.number)} · ${moneyShort(i.totalMinor, i.currency)}`,
        sub: `${who} · ${i.createdBy === 'ai' ? 'створив ШІ' : 'вручну'}`,
        page: 'orders',
        params: { draftId: i.draftId, tab: 'all' },
      };
    case 'payment_problem':
      return {
        icon: 'credit-card',
        tone: 'danger',
        title: `Оплата ${orderNo(i.number)}: ${(i.flag && FLAG[i.flag]) ?? PAY[i.state] ?? i.state}`,
        sub: `${who} · ${moneyShort(i.totalMinor, i.currency)}`,
        page: 'orders',
        params: { draftId: i.draftId, tab: 'all' },
      };
    case 'ttn_problem':
      return {
        icon: 'truck',
        tone: 'danger',
        title: `ТТН ${orderNo(i.number)}: ${i.ttnState === 'failed' ? 'не створено' : 'невідомо, чи створено'}`,
        sub: i.ttnState === 'failed' ? `${who}${i.ttnError ? ` · ${i.ttnError}` : ''}` : `${who} · перевірте кабінет Нової Пошти`,
        page: 'orders',
        params: { draftId: i.draftId, tab: 'all' },
      };
  }
}

/**
 * Top-bar bell and notification panel: hand-offs, new orders, payment and TTN problems of the last 30 days. Opening the
 * panel marks everything seen for this member; items that were unread at that moment stay highlighted until it closes.
 */
export function Bell({ base, go }: { base: string; go: (p: Page, np?: NavParams) => void }) {
  const say = useToast();
  const feed = useLoad(() => api<Feed>('GET', `${base}/notification-feed?limit=30`), [base], 15_000);
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const unread = feed.data?.unread ?? 0;
  const toggle = async () => {
    if (open) return setOpen(false);
    setFresh(new Set((feed.data?.items ?? []).filter((i) => i.unread).map((i) => i.id)));
    setOpen(true);
    if (!unread) return;
    try {
      await api('POST', `${base}/notification-feed/seen`);
      await feed.reload();
    } catch (e) {
      say(errText(e), true);
    }
  };
  const items = feed.data?.items ?? [];
  return (
    <div style={{ position: 'relative' }} ref={box}>
      <button className="bell" title="Сповіщення" aria-label={unread ? `Сповіщення: ${unread} нових` : 'Сповіщення'} aria-expanded={open} onClick={() => void toggle()}>
        <Icon name="bell" size={18} />
        {unread > 0 && <span className="bell-dot" />}
      </button>
      {open && (
        <div className="notif" role="dialog" aria-label="Сповіщення">
          <div className="notif-head">
            <strong>Сповіщення</strong>
            <span className="subtle">за 30 днів</span>
          </div>
          <div className="notif-list">
            {feed.error && <div className="panel-empty err">{feed.error}</div>}
            {items.map((i) => {
              const r = row(i);
              return (
                <button
                  key={i.id}
                  className="notif-item"
                  data-fresh={fresh.has(i.id) ? '' : undefined}
                  onClick={() => {
                    setOpen(false);
                    go(r.page, r.params);
                  }}
                >
                  <span className="task-tile" style={{ background: `var(--${r.tone}-bg, var(--brand-50))`, color: `var(--${r.tone}-fg, var(--brand-700))` }}>
                    <Icon name={r.icon} size={16} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="notif-title">{r.title}</span>
                    <span className="notif-sub ellipsis">{r.sub}</span>
                  </span>
                  <span className="subtle" style={{ fontSize: 12, flex: 'none' }}>
                    {ago(i.at)}
                  </span>
                </button>
              );
            })}
            {feed.data && items.length === 0 && <div className="panel-empty">Нових подій немає.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
