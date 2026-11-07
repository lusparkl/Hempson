import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useShop } from '../App';
import { api, monthName, useLoad, when, type AiSettings } from '../api';
import { Alert, Avatar, Badge, Button, Icon, Input, Panel, Select, Switch, Textarea, UsageMeter, useRun, type IconName, type Tone } from '../ui';

type Policy = { topic: 'delivery' | 'returns' | 'payment' | 'hours'; text: string; version: number; updatedAt: string | null };
type Status = 'not_connected' | 'connected' | 'needs_reconnect';
type Np = {
  available: boolean;
  status: Status;
  senderReady: boolean;
  senderPhone: string | null;
  senderCityName: string | null;
  senderWarehouseName: string | null;
  codEnabled: boolean;
  prepaidEnabled: boolean;
  refusalLimit: number;
  parcelWeightKg: string;
  parcelDescription: string;
  lastError: string | null;
};
type Mono = {
  available: boolean;
  status: Status;
  merchantName: string | null;
  webhookReady: boolean;
  paymentTimeoutHours: number;
  reminderHoursBefore: number;
  lastError: string | null;
};
type NpCity = { ref: string; name: string; area: string | null };
type NpBranch = { ref: string; number: string | null; name: string };
type Notify = { telegram: { available: boolean; chatId: string | null } };
type Web = { enabled: boolean; widgetKey: string | null; allowedOrigins: string[]; snippet: string | null };
type Ig = { available: boolean; status: Status; username: string | null; tokenExpiresAt: string | null; lastError: string | null };
type Tg = { available: boolean; status: Status; botUsername: string | null; lastError: string | null };
type Member = { userId: string; email: string; displayName: string; role: string };
type Storefront = { enabled: boolean; url: string; products: number };
type PhotoIndex = { available: boolean; withPhoto: number; indexed: number; failed: number; pending: number };

type Tab = 'channels' | 'ai' | 'rules' | 'ship' | 'team';
const TABS: Array<[Tab, string, IconName]> = [
  ['channels', 'Канали', 'message-circle'],
  ['ai', 'ШІ-асистент', 'bot'],
  ['rules', 'Правила магазину', 'book-open'],
  ['ship', 'Доставка й оплата', 'truck'],
  ['team', 'Команда', 'users'],
];
const STATUS_BADGE: Record<Status, [string, Tone]> = {
  connected: ['Підключено', 'success'],
  needs_reconnect: ['Потрібно підключити знову', 'danger'],
  not_connected: ['Не підключено', 'neutral'],
};

export function Settings() {
  const { shop, params } = useShop();
  const base = `/v1/shops/${shop.shopId}`;
  const owner = shop.role === 'owner';
  const [tab, setTab] = useState<Tab>(() => TABS.find(([k]) => k === params.tab)?.[0] ?? 'channels');
  return (
    <div className="settings">
      <nav aria-label="Розділи налаштувань">
        {TABS.map(([k, l, icon]) => (
          <button key={k} className="nav-btn" aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>
            <Icon name={icon} size={18} />
            {l}
          </button>
        ))}
      </nav>
      <div className="stack">
        {!owner && (
          <Alert tone="info" icon="shield-check">
            Змінювати налаштування може лише власник магазину.
          </Alert>
        )}
        {tab === 'channels' && (
          <>
            <Panel title="Канали клієнтів">
              <InstagramRow base={base} owner={owner} />
              <TelegramBotRow base={base} owner={owner} />
              <WebChatRows base={base} owner={owner} />
              <StorefrontRow base={base} owner={owner} />
            </Panel>
            <Panel title="Сповіщення для команди">
              <NotifyRow base={base} owner={owner} />
            </Panel>
          </>
        )}
        {tab === 'ai' && (
          <>
            <AiTab base={base} owner={owner} />
            <PhotoSearchPanel base={base} owner={owner} />
          </>
        )}
        {tab === 'rules' && <RulesTab base={base} owner={owner} />}
        {tab === 'ship' && (
          <>
            <NovaPoshtaCard base={base} owner={owner} />
            <MonobankCard base={base} owner={owner} />
          </>
        )}
        {tab === 'team' && <TeamTab base={base} owner={owner} />}
      </div>
    </div>
  );
}

function Row({ title, desc, children }: { title: string; desc: ReactNode; children?: ReactNode }) {
  return (
    <div className="srow">
      <div>
        <div className="s-title">{title}</div>
        <div className="s-desc">{desc}</div>
      </div>
      {children && <div className="srow-ctl">{children}</div>}
    </div>
  );
}
function Block({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="sblock">
      <div>
        <div className="s-title">{title}</div>
        {desc && <div className="s-desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}
const Loading = ({ error }: { error: string | null }) => <div className="panel-text">{error ?? 'Завантаження…'}</div>;

/* ---------------- channels ---------------- */

const IG_RESULT: Record<string, string> = {
  connected: 'Instagram підключено.',
  denied: 'Доступ у Instagram не надано.',
  taken: 'Цей Instagram-акаунт уже підключений до іншого магазину.',
  select_one: 'Під час входу потрібно вибрати рівно один Instagram-акаунт. Підключіть ще раз.',
  error: 'Не вдалося підключити Instagram. Спробуйте ще раз.',
};

function InstagramRow({ base, owner }: { base: string; owner: boolean }) {
  const ig = useLoad(() => api<Ig>('GET', `${base}/instagram`), [base]);
  const run = useRun();
  const result = IG_RESULT[new URLSearchParams(window.location.search).get('instagram') ?? ''];
  if (!ig.data) return <Loading error={ig.error} />;
  const d = ig.data;
  const connect = () =>
    void run(async () => {
      const r = await api<{ authorizeUrl: string }>('POST', `${base}/instagram/connect`);
      window.location.assign(r.authorizeUrl);
    }, null);
  const disconnect = () =>
    window.confirm('Відключити Instagram? Токен буде видалено, відповіді в Instagram припиняться.') &&
    void run(async () => {
      await api('DELETE', `${base}/instagram`);
      await ig.reload();
    }, 'Instagram відключено');
  const desc =
    d.status === 'connected'
      ? `Підключено${d.username ? `: @${d.username}` : ''}. ${d.tokenExpiresAt ? `Токен діє до ${new Date(d.tokenExpiresAt).toLocaleDateString('uk-UA')}.` : 'Токен без строку дії.'}`
      : d.status === 'needs_reconnect'
        ? 'Токен більше не діє: відповіді в Instagram не надсилаються.'
        : 'Не підключено. Потрібен професійний акаунт Instagram.';
  return (
    <>
      <Row title="Instagram" desc={desc}>
        <Badge tone={STATUS_BADGE[d.status][1]}>{STATUS_BADGE[d.status][0]}</Badge>
        {owner && d.available && (
          <Button variant={d.status === 'connected' ? 'secondary' : 'primary'} size="sm" onClick={connect}>
            {d.status === 'connected' ? 'Підключити знову' : 'Підключити Instagram'}
          </Button>
        )}
        {owner && d.available && d.status !== 'not_connected' && (
          <Button variant="secondary" size="sm" onClick={disconnect}>
            Відключити
          </Button>
        )}
      </Row>
      {(result || !d.available || (d.lastError && d.status === 'connected')) && (
        <div style={{ padding: '0 20px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {result && <Alert tone="info">{result}</Alert>}
          {!d.available && <Alert>Сервер не налаштований для Instagram (ключі Meta-застосунку та HEPSON_MASTER_KEY).</Alert>}
          {d.lastError && d.status === 'connected' && <Alert tone="warning">Є проблема: {d.lastError}</Alert>}
        </div>
      )}
    </>
  );
}

function TelegramBotRow({ base, owner }: { base: string; owner: boolean }) {
  const tg = useLoad(() => api<Tg>('GET', `${base}/telegram`), [base]);
  const run = useRun();
  if (!tg.data) return <Loading error={tg.error} />;
  const d = tg.data;
  const connect = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const token = String(new FormData(form).get('token') ?? '');
    void run(async () => {
      await api('PUT', `${base}/telegram`, { token });
      form.reset();
      await tg.reload();
    }, 'Telegram-бота підключено');
  };
  const disconnect = () =>
    window.confirm('Відключити Telegram-бота? Токен буде видалено, відповіді в Telegram припиняться.') &&
    void run(async () => {
      await api('DELETE', `${base}/telegram`);
      await tg.reload();
    }, 'Telegram-бота відключено');
  return (
    <Block
      title="Telegram-бот для клієнтів"
      desc={
        d.status === 'connected'
          ? `Підключено${d.botUsername ? `: @${d.botUsername}` : ''}.`
          : d.status === 'needs_reconnect'
            ? 'Токен більше не діє: відповіді в Telegram не надсилаються. Вставте новий токен.'
            : 'Не підключено. Створіть бота в @BotFather і вставте його токен.'
      }
    >
      {!d.available && <Alert>Сервер не налаштований для Telegram (HEPSON_MASTER_KEY та HTTPS-адреса HEPSON_PUBLIC_URL).</Alert>}
      {owner && d.available && (
        <form className="inline-form" onSubmit={connect}>
          <div className="grow">
            <Input label="Токен бота" name="token" type="password" autoComplete="off" placeholder="123456:ABC…" required />
          </div>
          <Button variant="primary" size="md" type="submit">
            {d.status === 'not_connected' ? 'Підключити' : 'Замінити токен'}
          </Button>
          {d.status !== 'not_connected' && (
            <Button variant="secondary" size="md" onClick={disconnect}>
              Відключити
            </Button>
          )}
        </form>
      )}
    </Block>
  );
}

function StorefrontRow({ base, owner }: { base: string; owner: boolean }) {
  const sf = useLoad(() => api<Storefront>('GET', `${base}/storefront`), [base]);
  const run = useRun();
  if (!sf.data) return <Loading error={sf.error} />;
  const d = sf.data;
  const toggle = (enabled: boolean) =>
    run(
      async () => {
        await api('PATCH', base, { storefrontEnabled: enabled });
        await sf.reload();
      },
      enabled ? 'Вітрину увімкнено' : 'Вітрину вимкнено',
    );
  return (
    <Row
      title="Вітрина"
      desc={
        <>
          Публічна сторінка з товарами в наявності (без залишків). Замовлення — через чати магазину: чат на сайті з’являється на вітрині, якщо його увімкнено.
          {d.enabled && (
            <>
              {' '}
              <a href={d.url} target="_blank" rel="noopener noreferrer">
                {d.url}
              </a>{' '}
              · товарів: {d.products}
            </>
          )}
        </>
      }
    >
      <Switch label="Увімкнено" checked={d.enabled} disabled={!owner} onChange={(e) => void toggle(e.target.checked)} />
    </Row>
  );
}

function PhotoSearchPanel({ base, owner }: { base: string; owner: boolean }) {
  const p = useLoad(() => api<PhotoIndex>('GET', `${base}/photo-index`), [base]);
  const run = useRun();
  if (!p.data)
    return (
      <Panel title="Пошук за фото">
        <Loading error={p.error} />
      </Panel>
    );
  const d = p.data;
  return (
    <Panel title="Пошук за фото">
      {!d.available ? (
        <div className="panel-text">Сервер не налаштований для пошуку за фото (потрібні OPENAI_API_KEY і модель із підтримкою зображень).</div>
      ) : (
        <Row
          title="Фото товарів"
          desc={
            d.withPhoto === 0
              ? 'Додайте посилання на фото товарів (колонка images в імпорті), щоб асистент знаходив товар за фото клієнта.'
              : `Проіндексовано ${d.indexed} з ${d.withPhoto}${d.pending ? `, в черзі ${d.pending}` : ''}${d.failed ? `, не вдалося ${d.failed} (посилання не відкривається або на фото немає товару)` : ''}. Асистент порівнює фото від клієнта з цими фото й пропонує схожі товари.`
          }
        >
          {owner && d.failed > 0 && (
            <Button
              variant="secondary"
              size="md"
              onClick={() =>
                void run(async () => {
                  await api('POST', `${base}/photo-index/retry`);
                  await p.reload();
                }, 'Фото поставлено в чергу')
              }
            >
              Спробувати ще раз
            </Button>
          )}
        </Row>
      )}
    </Panel>
  );
}

function WebChatRows({ base, owner }: { base: string; owner: boolean }) {
  const w = useLoad(() => api<Web>('GET', `${base}/web-chat`), [base]);
  const run = useRun();
  const [origins, setOrigins] = useState('');
  useEffect(() => {
    setOrigins(w.data?.allowedOrigins.join(', ') ?? '');
  }, [w.data]);
  if (!w.data) return <Loading error={w.error} />;
  const d = w.data;
  const put = (enabled: boolean, list: string[]) =>
    run(async () => {
      await api('PUT', `${base}/web-chat`, { enabled, allowedOrigins: list });
      await w.reload();
    });
  const parsed = () =>
    origins
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  return (
    <>
      <Row title="Чат на сайті" desc="Код віджета вставте перед закриттям body на дозволеному сайті.">
        <Switch label="Увімкнено" checked={d.enabled} disabled={!owner} onChange={(e) => void put(e.target.checked, d.allowedOrigins)} />
      </Row>
      <Block title="Дозволені сайти" desc="Віджет працюватиме лише на цих доменах. Кілька — через кому.">
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void put(d.enabled, parsed());
          }}
        >
          <div className="grow">
            <Input label="Домен" value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://shop.example" disabled={!owner} />
          </div>
          {owner && d.snippet && (
            <Button
              variant="secondary"
              size="md"
              onClick={() =>
                window.confirm('Старий код перестане працювати. Продовжити?') &&
                void run(async () => {
                  await api('POST', `${base}/web-chat/rotate-key`);
                  await w.reload();
                }, 'Новий ключ віджета створено')
              }
            >
              Новий ключ
            </Button>
          )}
          {owner && (
            <Button variant="primary" size="md" type="submit">
              Зберегти
            </Button>
          )}
        </form>
        {d.snippet && (
          <>
            <div className="s-desc">Вставте перед &lt;/body&gt; на дозволеному сайті:</div>
            <pre className="code">{d.snippet}</pre>
          </>
        )}
      </Block>
    </>
  );
}

function NotifyRow({ base, owner }: { base: string; owner: boolean }) {
  const n = useLoad(() => api<Notify>('GET', `${base}/notifications`), [base]);
  const run = useRun();
  if (!n.data) return <Loading error={n.error} />;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = String(new FormData(e.currentTarget).get('chat') ?? '').trim();
    void run(async () => {
      await api('PUT', `${base}/notifications`, { telegramChatId: v || null });
      await n.reload();
    });
  };
  return (
    <Block title="Telegram-сповіщення" desc="Дізнавайтеся про запити до людини й нові замовлення в Telegram. Порожньо — вимкнено.">
      {!n.data.telegram.available && <Alert>На сервері не задано HEPSON_TELEGRAM_BOT_TOKEN: сповіщення не надсилаються.</Alert>}
      <form className="inline-form" onSubmit={submit} key={n.data.telegram.chatId ?? ''}>
        <div className="grow">
          <Input label="Chat id або @канал" name="chat" defaultValue={n.data.telegram.chatId ?? ''} placeholder="-1001234567890" disabled={!owner} />
        </div>
        {owner && (
          <Button variant="primary" size="md" type="submit">
            Зберегти
          </Button>
        )}
      </form>
    </Block>
  );
}

/* ---------------- AI ---------------- */

function AiTab({ base, owner }: { base: string; owner: boolean }) {
  const { usage, refresh } = useShop();
  const ai = useLoad(() => api<AiSettings>('GET', `${base}/ai`), [base]);
  const run = useRun();
  if (!ai.data) return <Loading error={ai.error} />;
  const d = ai.data;
  const save = (patch: Partial<Pick<AiSettings, 'enabled' | 'instructions' | 'autonomy' | 'autoConfirmMaxMinor'>>) =>
    void run(async () => {
      await api('PUT', `${base}/ai`, { enabled: d.enabled, instructions: d.instructions, autonomy: d.autonomy, autoConfirmMaxMinor: d.autoConfirmMaxMinor, ...patch });
      await ai.reload();
      refresh();
    });
  const auto = d.autonomy === 'auto_confirm';
  const resets = usage ? new Date(usage.periodEnd).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' }) : '';
  return (
    <>
      <Panel title="Поведінка асистента">
        {!d.available && (
          <div style={{ padding: '0 20px 16px', marginTop: 16 }}>
            <Alert>На сервері не налаштовано модель (OPENAI_API_KEY, HEPSON_OPENAI_MODEL): асистент не працюватиме.</Alert>
          </div>
        )}
        <Row title="Відповідати клієнтам" desc="Асистент сам відповідає в усіх підключених каналах.">
          <Switch label="Увімкнено" checked={d.enabled} disabled={!owner} onChange={(e) => save({ enabled: e.target.checked })} />
        </Row>
        <Row
          title="Підтверджувати замовлення автоматично"
          desc={auto ? 'Увімкнено — замовлення, що пройшли всі перевірки, підтверджуються без вас.' : 'Вимкнено — кожне замовлення підтверджує людина.'}
        >
          <Switch label="Увімкнено" checked={auto} disabled={!owner} onChange={(e) => save({ autonomy: e.target.checked ? 'auto_confirm' : 'approval_required' })} />
        </Row>
        <Block title="Ліміт суми для автопідтвердження" desc="Замовлення вище цієї суми завжди чекають вашого підтвердження. Порожньо — без ліміту.">
          <form
            className="inline-form"
            key={String(d.autoConfirmMaxMinor)}
            onSubmit={(e) => {
              e.preventDefault();
              const cap = String(new FormData(e.currentTarget).get('cap') ?? '')
                .trim()
                .replace(',', '.');
              save({ autoConfirmMaxMinor: cap ? Math.round(Number(cap) * 100) : null });
            }}
          >
            <div style={{ flex: '0 1 220px' }}>
              <Input
                label="Сума, грн"
                name="cap"
                inputMode="decimal"
                placeholder="Без ліміту"
                defaultValue={d.autoConfirmMaxMinor === null ? '' : String(d.autoConfirmMaxMinor / 100)}
                disabled={!owner}
              />
            </div>
            {owner && (
              <Button variant="primary" size="md" type="submit">
                Зберегти
              </Button>
            )}
          </form>
          {d.autonomyChangedAt && <div className="s-desc">Режим змінено: {when(d.autonomyChangedAt)}</div>}
        </Block>
        <Block title="Додаткові інструкції" desc="Тон спілкування й особливості вашого бізнесу. Не скасовують жорсткі правила.">
          <form
            key={d.instructions}
            style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
            onSubmit={(e) => {
              e.preventDefault();
              save({ instructions: String(new FormData(e.currentTarget).get('instructions') ?? '') });
            }}
          >
            <Textarea label="Інструкції" name="instructions" rows={4} maxLength={2000} defaultValue={d.instructions} disabled={!owner} />
            {owner && (
              <div>
                <Button variant="primary" size="md" type="submit">
                  Зберегти
                </Button>
              </div>
            )}
          </form>
        </Block>
      </Panel>
      {usage && (
        <div className="panel panel-pad">
          <UsageMeter
            label={`Відповіді ШІ у ${monthName(usage.month, true)}`}
            value={usage.aiReplies}
            max={usage.aiReplyCap ?? Math.max(usage.aiReplies, 1)}
            valueLabel={usage.aiReplyCap === null ? String(usage.aiReplies) : `${usage.aiReplies} / ${usage.aiReplyCap}`}
          />
          <div style={{ fontSize: 13 }} className="subtle">
            План {usage.plan} · {usage.aiReplyCap === null ? 'без ліміту' : `ліміт оновиться ${resets}`}.
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------- rules ---------------- */

const POLICY_LABEL: Record<Policy['topic'], string> = { delivery: 'Доставка', returns: 'Повернення та обмін', payment: 'Оплата', hours: 'Графік роботи' };

/** Texts the AI may quote. A topic without text makes the AI hand the question to a person. */
function RulesTab({ base, owner }: { base: string; owner: boolean }) {
  const p = useLoad(() => api<{ items: Policy[] }>('GET', `${base}/policies`), [base]);
  const run = useRun();
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    setDraft(Object.fromEntries((p.data?.items ?? []).map((x) => [x.topic, x.text])));
  }, [p.data]);
  if (!p.data) return <Loading error={p.error} />;
  const items = p.data.items;
  const filled = items.filter((x) => x.text.trim()).length;
  const save = () =>
    void run(async () => {
      for (const x of items) if ((draft[x.topic] ?? '') !== x.text) await api('PUT', `${base}/policies/${x.topic}`, { text: draft[x.topic] ?? '' });
      await p.reload();
    }, 'Правила збережено');
  return (
    <Panel title="Правила магазину" meta={`${filled} з ${items.length} заповнено`}>
      <div className="panel-text">ШІ відповідає про доставку, повернення, оплату й графік лише цими словами. Порожнє поле — ШІ передає питання людині.</div>
      <div className="panel-body" style={{ gap: 18 }}>
        {items.map((x) => (
          <div key={x.topic}>
            <Textarea
              label={`${POLICY_LABEL[x.topic]}${x.version > 0 ? ` (версія ${x.version})` : ''}`}
              rows={3}
              maxLength={4000}
              value={draft[x.topic] ?? ''}
              onChange={(e) => setDraft({ ...draft, [x.topic]: e.target.value })}
              disabled={!owner}
            />
            {!(draft[x.topic] ?? '').trim() && (
              <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--warning-fg)' }}>
                <Icon name="circle-alert" size={14} />
                Не заповнено — ШІ передасть це питання людині.
              </div>
            )}
          </div>
        ))}
        {owner && (
          <div>
            <Button variant="primary" size="md" onClick={save}>
              Зберегти правила
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ---------------- delivery & payment ---------------- */

function NovaPoshtaCard({ base, owner }: { base: string; owner: boolean }) {
  const np = useLoad(() => api<Np>('GET', `${base}/nova-poshta`), [base]);
  const run = useRun();
  const [keyForm, setKeyForm] = useState(false);
  const [cities, setCities] = useState<NpCity[]>([]);
  const [city, setCity] = useState<NpCity | null>(null);
  const [branches, setBranches] = useState<NpBranch[]>([]);
  const [picking, setPicking] = useState(false);
  if (!np.data)
    return (
      <Panel title="Нова Пошта">
        <Loading error={np.error} />
      </Panel>
    );
  const d = np.data;
  const connect = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const apiKey = String(new FormData(form).get('apiKey') ?? '').trim();
    void run(async () => {
      await api('PUT', `${base}/nova-poshta/key`, { apiKey });
      form.reset();
      setKeyForm(false);
      await np.reload();
    }, 'Ключ Нової Пошти збережено');
  };
  const findCity = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    void run(async () => setCities((await api<{ items: NpCity[] }>('GET', `${base}/nova-poshta/cities?q=${encodeURIComponent(q)}`)).items), null);
  };
  const pickCity = (c: NpCity) =>
    void run(async () => {
      setCity(c);
      setCities([]);
      setBranches((await api<{ items: NpBranch[] }>('GET', `${base}/nova-poshta/branches?cityRef=${encodeURIComponent(c.ref)}&q=`)).items);
    }, null);
  const pickBranch = (b: NpBranch) =>
    void run(async () => {
      await api('PUT', `${base}/nova-poshta/settings`, { senderCityRef: city!.ref, senderCityName: city!.name, senderWarehouseRef: b.ref, senderWarehouseName: b.name });
      setCity(null);
      setBranches([]);
      setPicking(false);
      await np.reload();
    }, 'Відділення відправки збережено');
  const saveSettings = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(async () => {
      await api('PUT', `${base}/nova-poshta/settings`, {
        codEnabled: f.get('cod') === 'on',
        prepaidEnabled: f.get('prepaid') === 'on',
        refusalLimit: Number(f.get('refusalLimit')),
        parcelWeightKg: String(f.get('weight') ?? '1'),
        parcelDescription: String(f.get('description') ?? ''),
      });
      await np.reload();
    });
  };
  const sender = d.senderCityName && d.senderWarehouseName ? `${d.senderCityName}, ${d.senderWarehouseName}` : null;
  const showKey = owner && d.available && (d.status === 'not_connected' || keyForm);
  return (
    <Panel title="Нова Пошта" action={<Badge tone={STATUS_BADGE[d.status][1]}>{STATUS_BADGE[d.status][0]}</Badge>}>
      <div className="panel-text">
        {d.status === 'connected' && (
          <>
            {d.senderPhone ? `Відправник ${d.senderPhone}. ` : ''}Відділення відправки: {sender ?? <span className="err">не вибрано (ТТН не створюватимуться)</span>}.
          </>
        )}
        {d.status === 'needs_reconnect' && <span className="err">Нова Пошта не приймає ключ. Введіть ключ знову: поки цього не зроблено, ТТН не створюються.</span>}
        {d.status === 'not_connected' && 'Не підключено. Без ключа ШІ не оформлює замовлення. Ключ створюється в кабінеті НП: Налаштування → Безпека → API-ключ.'}
      </div>
      <div className="panel-body">
        {!d.available && <Alert>Сервер не налаштований для збереження ключів (HEPSON_MASTER_KEY).</Alert>}
        {showKey && (
          <form className="inline-form" onSubmit={connect}>
            <div className="grow">
              <Input label="API-ключ Нової Пошти" name="apiKey" type="password" autoComplete="off" required />
            </div>
            <Button variant="primary" size="md" type="submit">
              {d.status === 'not_connected' ? 'Підключити' : 'Зберегти ключ'}
            </Button>
          </form>
        )}
        {owner && d.status === 'connected' && picking && (
          <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <form className="inline-form" onSubmit={findCity}>
              <div className="grow">
                <Input label="Місто відправки" name="q" minLength={2} required />
              </div>
              <Button variant="secondary" size="md" type="submit">
                Знайти
              </Button>
            </form>
            <div className="pills">
              {cities.map((c) => (
                <button key={c.ref} type="button" className="choice" onClick={() => pickCity(c)}>
                  {c.name}
                  {c.area ? ` (${c.area})` : ''}
                </button>
              ))}
            </div>
            {city && branches.length === 0 && <div className="s-desc">У цьому місті не знайдено робочих відділень.</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
              {branches.map((b) => (
                <button key={b.ref} type="button" className="choice" onClick={() => pickBranch(b)}>
                  {b.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <form onSubmit={saveSettings} key={JSON.stringify(d)} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <label className="hs-check">
              <input type="checkbox" name="cod" defaultChecked={d.codEnabled} disabled={!owner} />
              <span className="hs-check__box" />
              Накладений платіж
            </label>
            <label className="hs-check">
              <input type="checkbox" name="prepaid" defaultChecked={d.prepaidEnabled} disabled={!owner} />
              <span className="hs-check__box" />
              Передоплата карткою (лише з підключеним monobank)
            </label>
          </div>
          <div className="fields">
            <Input label="Вага посилки, кг" name="weight" defaultValue={d.parcelWeightKg} disabled={!owner} />
            <Input label="Опис вмісту для ТТН" name="description" maxLength={100} defaultValue={d.parcelDescription} disabled={!owner} />
            <Select label="Відмов, після яких не пропонувати накладений платіж" name="refusalLimit" defaultValue={String(d.refusalLimit)} disabled={!owner}>
              <option value="0">Не обмежувати</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </Select>
          </div>
          {owner && (
            <div className="actions">
              <Button variant="primary" size="md" type="submit">
                Зберегти
              </Button>
              {d.status === 'connected' && (
                <Button variant="secondary" size="md" onClick={() => setPicking(!picking)}>
                  {sender ? 'Змінити відділення' : 'Вибрати відділення'}
                </Button>
              )}
              {d.available && d.status !== 'not_connected' && (
                <Button variant="secondary" size="md" onClick={() => setKeyForm(!keyForm)}>
                  Замінити ключ
                </Button>
              )}
              {d.status !== 'not_connected' && (
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() =>
                    window.confirm('Видалити ключ Нової Пошти?') &&
                    void run(async () => {
                      await api('DELETE', `${base}/nova-poshta/key`);
                      await np.reload();
                    }, 'Ключ видалено')
                  }
                >
                  Видалити ключ
                </Button>
              )}
            </div>
          )}
        </form>
      </div>
    </Panel>
  );
}

function MonobankCard({ base, owner }: { base: string; owner: boolean }) {
  const mono = useLoad(() => api<Mono>('GET', `${base}/monobank`), [base]);
  const run = useRun();
  const [tokenForm, setTokenForm] = useState(false);
  if (!mono.data)
    return (
      <Panel title="Оплата карткою · monobank">
        <Loading error={mono.error} />
      </Panel>
    );
  const d = mono.data;
  const connect = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const token = String(new FormData(form).get('token') ?? '');
    void run(async () => {
      await api('PUT', `${base}/monobank/token`, { token });
      form.reset();
      setTokenForm(false);
      await mono.reload();
    }, 'monobank підключено');
  };
  const disconnect = () =>
    window.confirm('Видалити токен monobank? Передоплата перестане пропонуватися; уже здійснені оплати буде зараховано.') &&
    void run(async () => {
      await api('DELETE', `${base}/monobank/token`);
      await mono.reload();
    }, 'monobank відключено');
  const saveSettings = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(async () => {
      await api('PUT', `${base}/monobank/settings`, { paymentTimeoutHours: Number(f.get('timeout')), reminderHoursBefore: Number(f.get('reminder')) });
      await mono.reload();
    });
  };
  const showToken = owner && d.available && (d.status === 'not_connected' || tokenForm);
  return (
    <Panel title="Оплата карткою · monobank" action={<Badge tone={STATUS_BADGE[d.status][1]}>{STATUS_BADGE[d.status][0]}</Badge>}>
      <div className="panel-text">
        {d.status === 'connected' &&
          `${d.merchantName ? `${d.merchantName}. ` : ''}Кошти надходять напряму на ваш рахунок monobank. Оплата зараховується лише після підтвердження від monobank.`}
        {d.status === 'needs_reconnect' && <span className="err">monobank не приймає токен: посилання на оплату не створюються. Підключіть знову.</span>}
        {d.status === 'not_connected' && 'Не підключено. Токен еквайрингу є в кабінеті web.monobank.ua (розділ «Інтернет-еквайринг»). Кошти надходять напряму на ваш рахунок.'}
      </div>
      <div className="panel-body">
        {!d.available && <Alert>Сервер не налаштований для збереження ключів (HEPSON_MASTER_KEY).</Alert>}
        {d.status === 'connected' && !d.webhookReady && (
          <Alert tone="info">Без HTTPS-адреси HEPSON_PUBLIC_URL оплати перевіряються періодичним запитом до monobank, тому зарахування може затримуватися на кілька хвилин.</Alert>
        )}
        {showToken && (
          <form className="inline-form" onSubmit={connect}>
            <div className="grow">
              <Input label="X-Token еквайрингу monobank" name="token" type="password" autoComplete="off" required />
            </div>
            <Button variant="primary" size="md" type="submit">
              {d.status === 'not_connected' ? 'Підключити' : 'Зберегти токен'}
            </Button>
          </form>
        )}
        <form onSubmit={saveSettings} key={JSON.stringify(d)} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="fields">
            <Input label="Скасувати неоплачене через, годин" name="timeout" type="number" min={1} max={720} defaultValue={d.paymentTimeoutHours} disabled={!owner} />
            <Input
              label="Нагадати за, годин до скасування"
              name="reminder"
              type="number"
              min={0}
              max={719}
              defaultValue={d.reminderHoursBefore}
              hint="0 — не нагадувати"
              disabled={!owner}
            />
          </div>
          {owner && (
            <div className="actions">
              <Button variant="primary" size="md" type="submit">
                Зберегти
              </Button>
              {d.available && d.status !== 'not_connected' && (
                <Button variant="secondary" size="md" onClick={() => setTokenForm(!tokenForm)}>
                  Замінити токен
                </Button>
              )}
              {d.status !== 'not_connected' && (
                <Button variant="secondary" size="md" onClick={disconnect}>
                  Відключити
                </Button>
              )}
            </div>
          )}
        </form>
      </div>
    </Panel>
  );
}

/* ---------------- team ---------------- */

function TeamTab({ base, owner }: { base: string; owner: boolean }) {
  const m = useLoad(() => api<Member[]>('GET', `${base}/members`), [base]);
  const run = useRun();
  const add = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void run(async () => {
      await api('POST', `${base}/members`, { email: String(f.get('email')), role: String(f.get('role')) });
      form.reset();
      await m.reload();
    }, 'Учасника додано');
  };
  return (
    <Panel title="Команда">
      {m.error && <div className="panel-text err">{m.error}</div>}
      {m.data?.map((x) => (
        <div key={x.userId} className="task">
          <Avatar name={x.displayName || x.email} seed={x.userId} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, color: 'var(--ink-900)' }}>{x.displayName}</div>
            <div style={{ fontSize: 13 }} className="subtle">
              {x.email}
            </div>
          </div>
          <Badge tone={x.role === 'owner' ? 'brand' : 'neutral'}>{x.role === 'owner' ? 'Власник' : 'Менеджер'}</Badge>
        </div>
      ))}
      {owner && (
        <Block title="Додати учасника" desc="Користувач має бути зареєстрований у Hepson.">
          <form className="inline-form" onSubmit={add}>
            <div className="grow">
              <Input label="Email" name="email" type="email" placeholder="name@example.com" required />
            </div>
            <div style={{ flex: '0 1 180px' }}>
              <Select label="Роль" name="role" defaultValue="manager">
                <option value="manager">Менеджер</option>
                <option value="owner">Власник</option>
              </Select>
            </div>
            <Button variant="primary" size="md" type="submit">
              Додати
            </Button>
          </form>
        </Block>
      )}
    </Panel>
  );
}
