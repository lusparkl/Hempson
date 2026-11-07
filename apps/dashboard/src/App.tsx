import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { LoginFlow } from '../../../packages/ui/src/embeds/LoginFlow';
import { Logo } from '../../../packages/ui/src/components';
import { ApiError, UNAUTHORIZED, api, errText, monthName, token, useLoad, type AiSettings, type Escalation, type Me, type Shop, type Usage } from './api';
import { Bell } from './Notifications';
import { ActionsSlot, Button, Icon, Input, ToastProvider, UsageMeter, type IconName } from './ui';
import { Catalog } from './views/Catalog';
import { Inbox } from './views/Inbox';
import { Orders } from './views/Orders';
import { Overview } from './views/Overview';
import { Playground } from './views/Playground';
import { Settings } from './views/Settings';
import { Stats } from './views/Stats';

export type Page = 'overview' | 'inbox' | 'orders' | 'catalog' | 'playground' | 'analytics' | 'settings';
const TITLES: Record<Page, string> = {
  overview: 'Огляд',
  inbox: 'Розмови',
  orders: 'Замовлення',
  catalog: 'Каталог',
  playground: 'Тест асистента',
  analytics: 'Статистика',
  settings: 'Налаштування',
};
const NAV: Array<[Page, IconName]> = [
  ['overview', 'layout-dashboard'],
  ['inbox', 'message-circle'],
  ['orders', 'shopping-bag'],
  ['catalog', 'package'],
  ['playground', 'sparkles'],
  ['analytics', 'chart-no-axes-column'],
  ['settings', 'settings'],
];
/** Optional deep-link from one page to another (open a conversation, an order, a catalog filter). */
export type NavParams = { conversationId?: string; draftId?: string; tab?: string; stock?: 'low' | 'out' };

type ShopContext = {
  shop: Shop;
  me: Me['user'] | null;
  go: (page: Page, params?: NavParams) => void;
  params: NavParams;
  escalations: Escalation[];
  pendingOrders: number;
  /** Conversations with a customer message this member has not seen. */
  unreadConversations: number;
  usage: Usage | null;
  ai: AiSettings | null;
  /** Reloads the shell's counters (open escalations, pending orders, unread conversations, usage, AI state). */
  refresh: () => void;
};
const Ctx = createContext<ShopContext | null>(null);
export const useShop = () => useContext(Ctx)!;

const pageFromHash = (): Page => {
  const h = location.hash.slice(1);
  return h in TITLES ? (h as Page) : 'overview';
};

/* ---------------- login ---------------- */

function AuthLayout({ onSubmit, children }: { onSubmit: (e: FormEvent<HTMLFormElement>) => void; children: ReactNode }) {
  return (
    <div className="login">
      <form onSubmit={onSubmit}>
        <Logo size={30} href={import.meta.env.VITE_SITE_URL ?? '/'} />
        <div className="login-body">{children}</div>
        <div style={{ fontSize: 13 }} className="subtle">
          © {new Date().getFullYear()} Hepson
        </div>
      </form>
      <div className="login-art">
        <LoginFlow />
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  // The public website's "start" buttons link here with `?mode=register`.
  const [mode, setMode] = useState<'login' | 'register'>(() => (new URLSearchParams(location.search).get('mode') === 'register' ? 'register' : 'login'));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email'));
    const password = String(f.get('password'));
    setBusy(true);
    setErr(null);
    try {
      if (mode === 'register') await api('POST', '/v1/auth/register', { email, password, displayName: String(f.get('name') || email) });
      const r = await api<{ token: string }>('POST', '/v1/auth/login', { email, password });
      token.set(r.token);
      onDone();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  };
  const reg = mode === 'register';
  return (
    <AuthLayout onSubmit={(e) => void submit(e)}>
      <div>
        <h1>{reg ? 'Створення кабінету' : 'Вхід у кабінет'}</h1>
        <p>{reg ? 'Зареєструйтеся, щоб підключити магазин і запустити ШІ-асистента.' : 'Керуйте розмовами, замовленнями й каталогом свого магазину.'}</p>
      </div>
      <Input label="Email" type="email" name="email" required autoComplete="username" />
      {reg && <Input label="Ім’я" name="name" autoComplete="name" />}
      <Input label="Пароль" type="password" name="password" required minLength={10} hint="Від 10 символів" autoComplete={reg ? 'new-password' : 'current-password'} />
      {err && (
        <div className="err" role="alert">
          {err}
        </div>
      )}
      <Button variant="primary" size="lg" type="submit" arrow disabled={busy}>
        {reg ? 'Зареєструватися' : 'Увійти'}
      </Button>
      <div style={{ fontSize: 14 }} className="muted">
        {reg ? 'Вже є кабінет? ' : 'Ще немає кабінету? '}
        <button type="button" className="linkbtn" onClick={() => setMode(reg ? 'login' : 'register')}>
          {reg ? 'Увійти' : 'Створити обліковий запис'}
        </button>
      </div>
    </AuthLayout>
  );
}

function NewShop({ onDone, onCancel }: { onDone: (id: string) => void; onCancel?: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const s = await api<Shop>('POST', '/v1/shops', { name: String(f.get('name')), slug: String(f.get('slug')) });
      onDone(s.shopId);
    } catch (x) {
      setErr(errText(x));
    }
  };
  return (
    <AuthLayout onSubmit={(e) => void submit(e)}>
      <div>
        <h1>Новий магазин</h1>
        <p>Назва бачитимуть клієнти; адреса потрібна для посилань і віджета.</p>
      </div>
      <Input label="Назва" name="name" required maxLength={120} placeholder="Лавка Софії" />
      <Input label="Адреса" name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" minLength={2} maxLength={63} placeholder="lavka-sofii" hint="Латиниця, цифри, дефіс" />
      {err && (
        <div className="err" role="alert">
          {err}
        </div>
      )}
      <Button variant="primary" size="lg" type="submit" arrow>
        Створити магазин
      </Button>
      {onCancel && (
        <button type="button" className="linkbtn" style={{ alignSelf: 'flex-start' }} onClick={onCancel}>
          Скасувати
        </button>
      )}
    </AuthLayout>
  );
}

/* ---------------- app ---------------- */

export function App() {
  const [authed, setAuthed] = useState(!!token.get());
  useEffect(() => {
    const off = () => {
      token.set(null);
      setAuthed(false);
    };
    window.addEventListener(UNAUTHORIZED, off);
    return () => window.removeEventListener(UNAUTHORIZED, off);
  }, []);
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return (
    <ToastProvider>
      <Shell
        onLogout={() => {
          void api('POST', '/v1/auth/logout').catch((e) => e instanceof ApiError || undefined);
          token.set(null);
          setAuthed(false);
        }}
      />
    </ToastProvider>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const shops = useLoad(() => api<Shop[]>('GET', '/v1/shops'), []);
  const me = useLoad(() => api<Me>('GET', '/v1/auth/me'), []);
  const [shopId, setShopId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (shops.error) return <p className="placeholder err">{shops.error}</p>;
  if (!shops.data) return <p className="placeholder">Завантаження…</p>;
  if (!shops.data.length || adding) {
    return (
      <NewShop
        onDone={(id) => {
          setAdding(false);
          setShopId(id);
          void shops.reload();
        }}
        onCancel={shops.data.length ? () => setAdding(false) : undefined}
      />
    );
  }
  const shop = shops.data.find((s) => s.shopId === shopId) ?? shops.data[0]!;
  return <ShopApp key={shop.shopId} shop={shop} shops={shops.data} me={me.data?.user ?? null} onPick={setShopId} onAdd={() => setAdding(true)} onLogout={onLogout} />;
}

function ShopApp({
  shop,
  shops,
  me,
  onPick,
  onAdd,
  onLogout,
}: {
  shop: Shop;
  shops: Shop[];
  me: Me['user'] | null;
  onPick: (id: string) => void;
  onAdd: () => void;
  onLogout: () => void;
}) {
  const base = `/v1/shops/${shop.shopId}`;
  const [page, setPage] = useState<Page>(pageFromHash);
  const [params, setParams] = useState<NavParams>({});
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const esc = useLoad(() => api<{ items: Escalation[] }>('GET', `${base}/escalations?status=open`), [base], 8000);
  const pending = useLoad(() => api<{ total: number }>('GET', `${base}/order-drafts?status=pending_approval&limit=1`), [base], 8000);
  const unread = useLoad(() => api<{ count: number }>('GET', `${base}/conversations/unread-count`), [base], 8000);
  const usage = useLoad(() => api<Usage>('GET', `${base}/usage`), [base], 60_000);
  const ai = useLoad(() => api<AiSettings>('GET', `${base}/ai`), [base]);

  useEffect(() => {
    const on = () => setPage(pageFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (p: Page, np: NavParams = {}) => {
    setParams(np);
    setPage(p);
    if (location.hash !== `#${p}`) history.replaceState(null, '', `#${p}`);
  };
  const ctx: ShopContext = {
    shop,
    me,
    go,
    params,
    escalations: esc.data?.items ?? [],
    pendingOrders: pending.data?.total ?? 0,
    unreadConversations: unread.data?.count ?? 0,
    usage: usage.data,
    ai: ai.data,
    refresh: () => {
      void esc.reload();
      void pending.reload();
      void unread.reload();
      void usage.reload();
      void ai.reload();
    },
  };
  const counts: Partial<Record<Page, number>> = { inbox: ctx.unreadConversations, orders: ctx.pendingOrders };
  const u = usage.data;
  const month = u ? monthName(u.month) : '';
  const st = aiState(ai.data, u);
  const name = me?.displayName || me?.email || '';

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <aside className="sb">
          <div className="sb-logo">
            <Logo size={28} href={import.meta.env.VITE_SITE_URL ?? '/'} />
          </div>
          <div className="store">
            <div className="store-box">
              <span className="store-initial">{shop.name[0]?.toUpperCase()}</span>
              <div className="lbl" style={{ flex: 1, minWidth: 0 }}>
                <div className="store-name">{shop.name}</div>
                <div className="store-role">{shop.role === 'owner' ? 'Власник' : 'Менеджер'}</div>
              </div>
              <span className="lbl" style={{ color: 'var(--ink-500)', display: 'flex' }}>
                <Icon name="chevrons-up-down" size={16} />
              </span>
            </div>
            <select value={shop.shopId} onChange={(e) => (e.target.value === '__new' ? onAdd() : onPick(e.target.value))} aria-label="Магазин">
              {shops.map((s) => (
                <option key={s.shopId} value={s.shopId}>
                  {s.name} · {s.role === 'owner' ? 'Власник' : 'Менеджер'}
                </option>
              ))}
              <option value="__new">+ Новий магазин</option>
            </select>
          </div>
          <nav className="nav" aria-label="Розділи">
            {NAV.map(([id, icon]) => (
              <button key={id} className="nav-btn" aria-current={page === id ? 'page' : undefined} title={TITLES[id]} onClick={() => go(id)}>
                <Icon name={icon} size={18} />
                <span className="lbl">{TITLES[id]}</span>
                {!!counts[id] && <span className="lbl nav-count">{counts[id]}</span>}
              </button>
            ))}
          </nav>
          <div style={{ flex: 1 }} />
          {u && (
            <div className="lbl sb-usage">
              <UsageMeter
                label={`Відповіді ШІ · ${month}`}
                value={u.aiReplies}
                max={u.aiReplyCap ?? Math.max(u.aiReplies, 1)}
                valueLabel={u.aiReplyCap === null ? String(u.aiReplies) : `${u.aiReplies} / ${u.aiReplyCap}`}
              />
              <div style={{ fontSize: 12 }} className="subtle">
                План {u.plan} · {u.remaining === null ? 'без ліміту' : `залишилось ${u.remaining}`}
              </div>
            </div>
          )}
          <div className="sb-user">
            <span className="av" style={{ width: 34, height: 34, background: 'var(--brand-50)', color: 'var(--brand-700)', fontSize: 14 }} aria-hidden="true">
              {(name[0] ?? '?').toUpperCase()}
            </span>
            <div className="lbl" style={{ flex: 1, minWidth: 0 }}>
              <div className="ellipsis" style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-900)' }}>
                {me?.displayName ?? ''}
              </div>
              <div className="ellipsis subtle" style={{ fontSize: 12 }}>
                {me?.email ?? ''}
              </div>
            </div>
            <button className="iconbtn" onClick={onLogout} title="Вийти" aria-label="Вийти">
              <Icon name="log-out" size={18} />
            </button>
          </div>
        </aside>
        <div className="main-col">
          <header className="topbar">
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1>{TITLES[page]}</h1>
            </div>
            <div className="page-actions" ref={setSlot} />
            <div className="ai-state" title={st.title}>
              <span className="ai-dot" style={{ background: st.color, boxShadow: `0 0 0 3px ${st.ring}` }} />
              <span>{st.label}</span>
            </div>
            <Bell base={base} go={go} />
          </header>
          <main className="content">
            <ActionsSlot value={slot}>
              {page === 'overview' && <Overview />}
              {page === 'inbox' && <Inbox />}
              {page === 'orders' && <Orders />}
              {page === 'catalog' && <Catalog />}
              {page === 'playground' && <Playground />}
              {page === 'analytics' && <Stats />}
              {page === 'settings' && <Settings />}
            </ActionsSlot>
          </main>
        </div>
      </div>
    </Ctx.Provider>
  );
}

function aiState(ai: AiSettings | null, u: Usage | null) {
  if (!ai) return { label: '…', title: '', color: 'var(--ink-300)', ring: 'var(--ink-100)' };
  if (!ai.available) return { label: 'ШІ недоступний', title: 'На сервері не налаштовано модель', color: 'var(--danger-fg)', ring: 'var(--danger-bg)' };
  if (!ai.enabled) return { label: 'ШІ вимкнено', title: 'Увімкніть у Налаштування → ШІ-асистент', color: 'var(--ink-400)', ring: 'var(--ink-100)' };
  if (u?.capReached) return { label: 'Ліміт вичерпано', title: 'Ліміт відповідей ШІ на місяць вичерпано', color: 'var(--warning-fg)', ring: 'var(--warning-bg)' };
  return { label: 'ШІ працює', title: 'Асистент відповідає клієнтам', color: 'var(--success-fg)', ring: 'var(--success-bg)' };
}
