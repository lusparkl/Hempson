import { useState } from 'react';
import { useShop } from '../App';
import { api, moneyShort, revenue, statsUrl, useLoad, type StatsData } from '../api';
import { FunnelRows, HeaderActions, Icon, Panel } from '../ui';

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
const nf = (n: number) => n.toLocaleString('uk-UA');

export function Stats() {
  const { shop } = useShop();
  const [days, setDays] = useState(30);
  const s = useLoad(() => api<StatsData>('GET', statsUrl(shop.shopId, days)), [shop.shopId, days]);
  const d = s.data;
  const rev = d ? revenue(d, shop.defaultCurrency) : null;
  const max = Math.max(1, ...(d?.daily.map((x) => x.replied) ?? []));
  const rows = (pairs: Array<[string, string | number]>) =>
    pairs.map(([k, v]) => (
      <div key={k} className="trow">
        <span className="muted">{k}</span>
        <strong>{typeof v === 'number' ? nf(v) : v}</strong>
      </div>
    ));

  return (
    <div className="page">
      <HeaderActions>
        <div className="seg" role="group" aria-label="Період">
          {[7, 30, 90].map((n) => (
            <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>
              {n} днів
            </button>
          ))}
        </div>
      </HeaderActions>
      {s.error && <div className="err">{s.error}</div>}
      {d?.usage.capReached && (
        <div className="notice warning">
          <Icon name="circle-alert" size={20} />
          <div>Ліміт відповідей ШІ на {d.usage.month} вичерпано. До кінця місяця ШІ не відповідає: нові розмови передаються людям. Щоб збільшити ліміт, зверніться до Hepson.</div>
        </div>
      )}
      {d && rev && (
        <>
          <div className="kpis sm">
            {[
              { label: 'Повідомлення від клієнтів', value: nf(d.messages.incoming), sub: `за ${days} днів` },
              { label: 'Відповіді ШІ', value: nf(d.messages.outgoingAi), sub: d.ai.replyRate === null ? 'частка —' : `частка ${Math.round(d.ai.replyRate * 100)}%` },
              { label: 'Підтверджено замовлень', value: nf(d.funnel.approved), sub: moneyShort(rev.totalMinor, rev.currency) },
              { label: 'Середній час опрацювання', value: d.escalations.avgResolutionSeconds === null ? '—' : `${Math.round(d.escalations.avgResolutionSeconds / 60)} хв`, sub: 'запити до людини' },
            ].map((k) => (
              <div key={k.label} className="kpi" style={{ gap: 0 }}>
                <div className="kpi-label">{k.label}</div>
                <div className="kpi-value" style={{ marginTop: 6, lineHeight: 1.15 }}>
                  {k.value}
                </div>
                <div className="kpi-sub" style={{ marginTop: 2 }}>
                  {k.sub}
                </div>
              </div>
            ))}
          </div>
          <Panel
            title="Повідомлення"
            action={
              <span className="legend">
                <span>
                  <i style={{ background: 'var(--brand-600)' }} />
                  ШІ
                </span>
                {/* P10: per-day human replies in the stats API; the series is empty until then. */}
                <span title="Щоденні відповіді людей з’являться незабаром">
                  <i style={{ background: 'var(--accent-pink)' }} />
                  Люди
                </span>
              </span>
            }
          >
            <div className="bars" style={{ gap: d.daily.length > 12 ? 6 : 14 }}>
              {d.daily.map((b) => (
                <div key={b.date} title={`${fmtDay(b.date)}: відповідей ШІ ${b.replied}, запусків ${b.runs}`}>
                  <div style={{ background: 'var(--brand-600)', borderRadius: 2, height: `${Math.max(b.replied ? 2 : 0, (b.replied / max) * 100)}%` }} />
                </div>
              ))}
              {d.daily.length === 0 && <div className="placeholder">Даних за період немає</div>}
            </div>
            <div className="bars-axis">
              <span>{fmtDay(d.period.from)}</span>
              <span>{fmtDay(d.period.to)}</span>
            </div>
          </Panel>
          <div className="cols" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))' }}>
            <Panel title="Воронка">
              <FunnelRows
                rows={[
                  { label: 'Розмови з повідомленням клієнта', value: d.funnel.conversations },
                  { label: 'Чернетки замовлень', value: d.funnel.drafts },
                  { label: 'Підтверджено', value: d.funnel.approved },
                  { label: 'Оплачено (передоплата)', value: d.funnel.paid },
                  { label: 'Відправлено', value: d.funnel.shipped },
                  { label: 'Отримано', value: d.funnel.delivered },
                ]}
              />
            </Panel>
            <div className="stack">
              <Panel title="Повідомлення" clip>
                {rows([
                  ['Від клієнтів', d.messages.incoming],
                  ['Відповіді ШІ', d.messages.outgoingAi],
                  ['Відповіді людей', d.messages.outgoingHuman],
                  ['Не надіслано', d.messages.failedOutgoing],
                  ['Активні розмови', d.conversations.active],
                  ['Нові клієнти', d.conversations.newCustomers],
                  ['Розмови з ШІ на паузі', d.conversations.aiPausedNow],
                ])}
              </Panel>
              <Panel title="ШІ" clip>
                {rows([
                  ['Запусків', d.ai.runs],
                  ...Object.entries(d.ai.byStatus).map(([k, v]): [string, number] => [`· ${k}`, v]),
                  ['Запитів до моделі', d.ai.modelRequests],
                  ['Токени (вхід / вихід)', `${nf(d.ai.inputTokens)} / ${nf(d.ai.outputTokens)}`],
                ])}
              </Panel>
              <Panel title="Передано людині" clip>
                {rows([
                  ['Відкрито', d.escalations.opened],
                  ['Опрацьовано', d.escalations.resolved],
                  ['Відкриті зараз', d.escalations.openNow],
                ])}
              </Panel>
              <Panel title="ШІ і люди" clip>
                {rows([
                  ['Чернетки: ШІ / менеджер', `${d.orderSources.drafts.ai} / ${d.orderSources.drafts.human}`],
                  ['Підтвердили: від ШІ / від менеджера', `${d.orderSources.approved.ai} / ${d.orderSources.approved.human}`],
                  ['Підтвердив: людина / автоматично', `${d.orderSources.approvedBy.human} / ${d.orderSources.approvedBy.auto}`],
                ])}
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
