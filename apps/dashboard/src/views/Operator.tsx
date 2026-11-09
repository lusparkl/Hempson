import { useState, type FormEvent } from 'react';
import { AuthLayout } from '../App';
import { ApiError, ago, api, errText, shortWhen, useLoad, type Usage } from '../api';
import { Alert, Badge, Button, Drawer, Input, Panel, Select, Textarea, useRun, type Tone } from '../ui';

/** The key stays in this tab only: closing it ends operator access (D50). */
const KEY = 'hepson-operator-key';
const stored = {
  get: () => {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) sessionStorage.setItem(KEY, v);
      else sessionStorage.removeItem(KEY);
    } catch {
      /* storage blocked: the key lasts until reload */
    }
  },
};

type Channel = { connected: boolean; status: string; account: string | null; lastError: string | null };
type OpShop = {
  shopId: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  aiEnabled: boolean;
  operatorStoppedAt: string | null;
  operatorStopReason: string | null;
  channels: { instagram: (Channel & { tokenExpiresAt: string | null }) | null; telegram: Channel | null; website: boolean };
  tokens: { input: number; output: number; modelRequests: number };
  last24h: { runs: number; failedRuns: number; failedSends: number };
  lastRunAt: string | null;
  openEscalations: number;
  usage: Usage;
};
type OpRun = {
  runId: string;
  shopId: string;
  shopName: string;
  status: string;
  detail: string | null;
  model: string | null;
  modelRequests: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
};
type OpErrors = {
  alertsConfigured: boolean;
  incidents: Array<{ label: string; code: string; since: string }>;
  events: Array<{ label: string; detail: string; count: number; at: string }>;
  failedRuns: OpRun[];
};

const POLL_MS = 30_000;
const nf = (n: number) => n.toLocaleString('uk-UA');
const RUN_STATUS: Record<string, [string, Tone]> = {
  running: ['Виконується', 'info'],
  replied: ['Відповів', 'success'],
  send_uncertain: ['Доставка невідома', 'warning'],
  escalated: ['Передано людині', 'brand'],
  skipped: ['Пропущено', 'neutral'],
  superseded: ['Замінено новішим', 'neutral'],
  failed: ['Помилка', 'danger'],
};

function aiBadge(s: OpShop, aiAvailable: boolean): [string, Tone] {
  if (s.operatorStoppedAt) return ['Зупинено', 'danger'];
  if (!aiAvailable) return ['Немає моделі', 'danger'];
  if (!s.aiEnabled) return ['Вимкнено власником', 'neutral'];
  if (s.usage.planExpired) return ['Оплата закінчилась', 'warning'];
  if (s.usage.capReached) return ['Ліміт вичерпано', 'warning'];
  return ['Працює', 'success'];
}

function ChannelBadge({ name, c }: { name: string; c: Channel | null }) {
  if (!c) return null;
  const hint = [c.account, c.lastError].filter(Boolean).join(' · ');
  return (
    <span title={hint || undefined}>
      <Badge tone={c.connected ? 'success' : 'danger'}>{c.connected ? name : `${name}: перепідключити`}</Badge>
    </span>
  );
}

function RunRows({ runs }: { runs: OpRun[] }) {
  return (
    <div className="op-scroll">
      <table className="op-table">
        <thead>
          <tr>
            <th>Час</th>
            <th>Магазин</th>
            <th>Результат</th>
            <th>Код</th>
            <th>Модель</th>
            <th className="num">Запити</th>
            <th className="num">Токени</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const [label, tone] = RUN_STATUS[r.status] ?? [r.status, 'neutral'];
            return (
              <tr key={r.runId}>
                <td className="nowrap">{shortWhen(r.createdAt)}</td>
                <td>{r.shopName}</td>
                <td>
                  <Badge tone={tone}>{label}</Badge>
                </td>
                <td className="mono">{r.detail ?? '—'}</td>
                <td className="mono">{r.model ?? '—'}</td>
                <td className="num">{r.modelRequests}</td>
                <td className="num">{nf(r.inputTokens + r.outputTokens)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StopDrawer({ shop, bearer, onClose, onDone }: { shop: OpShop; bearer: string; onClose: () => void; onDone: () => void }) {
  const run = useRun();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const stopping = !shop.operatorStoppedAt;
  const submit = async () => {
    setBusy(true);
    const ok = await run(
      () => api('PUT', `/v1/operator/shops/${shop.shopId}/ai-stop`, stopping ? { stopped: true, reason } : { stopped: false }, bearer),
      stopping ? 'ШІ магазину зупинено' : 'ШІ магазину відновлено',
    );
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <Drawer
      title={stopping ? `Зупинити ШІ: ${shop.name}` : `Відновити ШІ: ${shop.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            Скасувати
          </Button>
          <Button size="md" disabled={busy} onClick={() => void submit()}>
            {stopping ? 'Зупинити ШІ' : 'Відновити ШІ'}
          </Button>
        </>
      }
    >
      {stopping ? (
        <>
          <Alert tone="warning">
            ШІ одразу перестане відповідати клієнтам цього магазину, навіть у запусках, що вже виконуються. Власник не зможе ввімкнути його сам. Клієнти автоматичної відповіді не
            отримають, а власнику надійде сповіщення в Telegram, якщо чат налаштовано.
          </Alert>
          <Textarea label="Причина (бачите лише ви)" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </>
      ) : (
        <>
          <Alert tone="info" icon="sparkles">
            Якщо власник не вимикав ШІ, асистент знову відповідатиме на нові повідомлення. На повідомлення, отримані під час зупинки, він не відповість.
          </Alert>
          {shop.operatorStopReason && <p className="muted">Причина зупинки: {shop.operatorStopReason}</p>}
        </>
      )}
    </Drawer>
  );
}

function Board({ bearer, onExit }: { bearer: string; onExit: (reason: string | null) => void }) {
  const get = <T,>(path: string) =>
    api<T>('GET', path, undefined, bearer).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onExit('Ключ не прийнято');
      throw e;
    });
  const [shopFilter, setShopFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [acting, setActing] = useState<OpShop | null>(null);
  const shops = useLoad(() => get<{ aiAvailable: boolean; shops: OpShop[] }>('/v1/operator/shops'), [], POLL_MS);
  const errors = useLoad(() => get<OpErrors>('/v1/operator/errors'), [], POLL_MS);
  const runsPath = `/v1/operator/runs?${new URLSearchParams({ limit: '50', ...(shopFilter ? { shopId: shopFilter } : {}), ...(statusFilter ? { status: statusFilter } : {}) })}`;
  const runs = useLoad(() => get<{ items: OpRun[]; total: number }>(runsPath), [runsPath], POLL_MS);

  const list = shops.data?.shops ?? [];
  const err = errors.data;
  const reconnect = list.flatMap((s) =>
    (
      [
        ['Instagram', s.channels.instagram],
        ['Telegram', s.channels.telegram],
      ] as const
    ).flatMap(([name, c]) => (c && !c.connected ? [{ key: `${s.shopId}:${name}`, shop: s.name, name, code: c.lastError ?? c.status }] : [])),
  );
  const noProblems = err && !err.incidents.length && !err.events.length && !err.failedRuns.length && !reconnect.length;
  const kpis = [
    { label: 'Магазини', value: nf(list.length), sub: `ШІ зупинено: ${list.filter((s) => s.operatorStoppedAt).length}` },
    { label: 'Запуски ШІ за 24 год', value: nf(list.reduce((a, s) => a + s.last24h.runs, 0)), sub: `з помилкою: ${list.reduce((a, s) => a + s.last24h.failedRuns, 0)}` },
    {
      label: 'Відповіді ШІ за місяць',
      value: nf(list.reduce((a, s) => a + s.usage.aiReplies, 0)),
      sub: `недоставлено за 24 год: ${list.reduce((a, s) => a + s.last24h.failedSends, 0)}`,
    },
    {
      label: 'Токени за місяць',
      value: nf(list.reduce((a, s) => a + s.tokens.input + s.tokens.output, 0)),
      sub: `запитів до моделі: ${nf(list.reduce((a, s) => a + s.tokens.modelRequests, 0))}`,
    },
  ];

  return (
    <div className="page">
      <header className="op-head">
        <h1>Панель оператора</h1>
        <Button variant="secondary" size="sm" icon="log-out" onClick={() => onExit(null)}>
          Вийти
        </Button>
      </header>
      {(shops.error || errors.error || runs.error) && <div className="err">{shops.error ?? errors.error ?? runs.error}</div>}
      {shops.data && !shops.data.aiAvailable && <Alert>На сервері не налаштовано модель: ШІ не працює в жодному магазині.</Alert>}

      <div className="kpis sm">
        {kpis.map((k) => (
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

      <Panel title="Помилки" meta={err && !err.alertsConfigured ? 'Сповіщення в Telegram вимкнено, стан сервісів не перевіряється' : 'Помилки сервера: з останнього запуску'} clip>
        {err?.incidents.map((i) => (
          <div key={i.label} className="trow">
            <span className="err">{i.label} не працює</span>
            <strong className="mono">
              {i.code} · {shortWhen(i.since)}
            </strong>
          </div>
        ))}
        {reconnect.map((r) => (
          <div key={r.key} className="trow">
            <span>
              {r.shop}: {r.name} потребує перепідключення
            </span>
            <strong className="mono">{r.code}</strong>
          </div>
        ))}
        {err?.events.map((e) => (
          <div key={e.label + e.detail} className="trow">
            <span>
              {e.label}
              {e.count > 1 && <span className="subtle"> ×{e.count}</span>}
            </span>
            <strong className="mono">
              {e.detail} · {shortWhen(e.at)}
            </strong>
          </div>
        ))}
        {noProblems && <div className="panel-empty">Помилок немає</div>}
        {!!err?.failedRuns.length && <RunRows runs={err.failedRuns} />}
      </Panel>

      <Panel title="Магазини" meta={shops.data ? `${list.length}` : undefined} clip>
        <div className="op-scroll">
          <table className="op-table">
            <thead>
              <tr>
                <th>Магазин</th>
                <th>ШІ</th>
                <th>Канали</th>
                <th className="num">Відповіді за місяць</th>
                <th className="num">Токени за місяць</th>
                <th className="num">24 год: запуски / помилки / недоставлено</th>
                <th className="num">Ескалації</th>
                <th>Останній запуск</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => {
                const [label, tone] = aiBadge(s, shops.data!.aiAvailable);
                return (
                  <tr key={s.shopId}>
                    <td>
                      <div className="op-name">{s.name}</div>
                      <div className="subtle">{s.ownerEmail ?? s.slug}</div>
                    </td>
                    <td>
                      <span title={s.operatorStopReason ?? undefined}>
                        <Badge tone={tone}>{label}</Badge>
                      </span>
                    </td>
                    <td>
                      <div className="op-channels">
                        <ChannelBadge name="Instagram" c={s.channels.instagram} />
                        <ChannelBadge name="Telegram" c={s.channels.telegram} />
                        {s.channels.website && <Badge tone="success">Сайт</Badge>}
                        {!s.channels.instagram && !s.channels.telegram && !s.channels.website && <span className="subtle">немає</span>}
                      </div>
                    </td>
                    <td className="num">
                      {nf(s.usage.aiReplies)} / {s.usage.aiReplyCap === null ? '∞' : nf(s.usage.aiReplyCap)}
                      <div className="subtle">{s.usage.plan}</div>
                    </td>
                    <td className="num">{nf(s.tokens.input + s.tokens.output)}</td>
                    <td className={`num${s.last24h.failedRuns + s.last24h.failedSends ? ' err' : ''}`}>
                      {s.last24h.runs} / {s.last24h.failedRuns} / {s.last24h.failedSends}
                    </td>
                    <td className="num">{s.openEscalations}</td>
                    <td className="nowrap">{ago(s.lastRunAt) || '—'}</td>
                    <td>
                      <Button variant={s.operatorStoppedAt ? 'primary' : 'secondary'} size="sm" onClick={() => setActing(s)}>
                        {s.operatorStoppedAt ? 'Відновити' : 'Зупинити ШІ'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {shops.data && !list.length && <div className="panel-empty">Магазинів ще немає</div>}
      </Panel>

      <Panel title="Останні запуски ШІ" meta={runs.data ? `${Math.min(runs.data.items.length, runs.data.total)} із ${nf(runs.data.total)}` : undefined} clip>
        <div className="op-filters">
          <Select label="Магазин" name="op-shop" value={shopFilter} onChange={(e) => setShopFilter(e.target.value)}>
            <option value="">Усі</option>
            {list.map((s) => (
              <option key={s.shopId} value={s.shopId}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select label="Результат" name="op-status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">Усі</option>
            {Object.entries(RUN_STATUS).map(([id, [label]]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        {runs.data && (runs.data.items.length ? <RunRows runs={runs.data.items} /> : <div className="panel-empty">Запусків немає</div>)}
      </Panel>

      {acting && (
        <StopDrawer
          shop={acting}
          bearer={bearer}
          onClose={() => setActing(null)}
          onDone={() => {
            setActing(null);
            void shops.reload();
          }}
        />
      )}
    </div>
  );
}

/** Opened at `#operator`, apart from any shop session. Signs in with an operator API key, which is checked by the first request. */
export function Operator() {
  const [bearer, setBearer] = useState(stored.get);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const key = String(new FormData(e.currentTarget).get('key')).trim();
    setBusy(true);
    setErr(null);
    try {
      await api('GET', '/v1/operator/errors', undefined, key);
      stored.set(key);
      setBearer(key);
    } catch (x) {
      setErr(x instanceof ApiError && x.status === 401 ? 'Ключ не прийнято' : errText(x));
    } finally {
      setBusy(false);
    }
  };
  if (bearer)
    return (
      <Board
        bearer={bearer}
        onExit={(reason) => {
          stored.set(null);
          setBearer(null);
          setErr(reason);
        }}
      />
    );
  return (
    <AuthLayout onSubmit={(e) => void submit(e)}>
      <div>
        <h1>Панель оператора</h1>
        <p>Лише для команди Hepson. Вхід за ключем оператора.</p>
      </div>
      <Input label="Ключ оператора" type="password" name="key" required autoComplete="off" hint="Створюється командою pnpm bootstrap-key" />
      {err && (
        <div className="err" role="alert">
          {err}
        </div>
      )}
      <Button variant="primary" size="lg" type="submit" arrow disabled={busy}>
        Увійти
      </Button>
    </AuthLayout>
  );
}
