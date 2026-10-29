import { useState } from 'react';
import { api, money, useLoad, type Shop } from '../api';

type Stats = {
  period: { from: string; to: string };
  messages: { incoming: number; outgoingAi: number; outgoingHuman: number; failedOutgoing: number };
  conversations: { active: number; newCustomers: number; aiPausedNow: number };
  ai: { runs: number; byStatus: Record<string, number>; modelRequests: number; inputTokens: number; outputTokens: number; replyRate: number | null };
  escalations: { opened: number; resolved: number; openNow: number; avgResolutionSeconds: number | null };
  orderDrafts: { byStatus: Record<string, number>; approved: Array<{ currency: string; count: number; totalMinor: number }> };
  daily: Array<{ date: string; runs: number; replied: number; escalated: number; inputTokens: number; outputTokens: number }>;
};

export function Stats({ shop }: { shop: Shop }) {
  const [days, setDays] = useState(30);
  const s = useLoad(() => api<Stats>('GET', `/v1/shops/${shop.shopId}/stats?from=${encodeURIComponent(new Date(Date.now() - days * 86_400_000).toISOString())}`), [shop.shopId, days]);
  const d = s.data;
  const row = (label: string, value: string | number) => (
    <tr><th>{label}</th><td>{value}</td></tr>
  );
  return (
    <>
      <p className="row">
        {[7, 30, 90].map((n) => (
          <button key={n} className={days === n ? 'active' : ''} onClick={() => setDays(n)}>
            {n} днів
          </button>
        ))}
      </p>
      {s.error && <p className="error">{s.error}</p>}
      {d && (
        <div className="grid">
          <table>
            <caption>Повідомлення</caption>
            <tbody>
              {row('Від клієнтів', d.messages.incoming)}
              {row('Відповіді ШІ', d.messages.outgoingAi)}
              {row('Відповіді людей', d.messages.outgoingHuman)}
              {row('Не надіслано', d.messages.failedOutgoing)}
              {row('Активні розмови', d.conversations.active)}
              {row('Нові клієнти', d.conversations.newCustomers)}
              {row('Розмови з ШІ на паузі', d.conversations.aiPausedNow)}
            </tbody>
          </table>
          <table>
            <caption>ШІ</caption>
            <tbody>
              {row('Запусків', d.ai.runs)}
              {row('Частка відповідей', d.ai.replyRate === null ? '—' : `${Math.round(d.ai.replyRate * 100)}%`)}
              {Object.entries(d.ai.byStatus).map(([k, v]) => row(`· ${k}`, v))}
              {row('Запитів до моделі', d.ai.modelRequests)}
              {row('Токени (вхід / вихід)', `${d.ai.inputTokens} / ${d.ai.outputTokens}`)}
            </tbody>
          </table>
          <table>
            <caption>Передано людині</caption>
            <tbody>
              {row('Відкрито', d.escalations.opened)}
              {row('Опрацьовано', d.escalations.resolved)}
              {row('Відкриті зараз', d.escalations.openNow)}
              {row('Середній час опрацювання', d.escalations.avgResolutionSeconds === null ? '—' : `${Math.round(d.escalations.avgResolutionSeconds / 60)} хв`)}
            </tbody>
          </table>
          <table>
            <caption>Замовлення</caption>
            <tbody>
              {Object.entries(d.orderDrafts.byStatus).map(([k, v]) => row(k, v))}
              {d.orderDrafts.approved.map((a) => row(`Підтверджено (${a.count})`, money(a.totalMinor, a.currency)))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
