import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, UNAUTHORIZED, api, errText, token, useLoad, type Shop } from './api';
import { Catalog } from './views/Catalog';
import { Inbox } from './views/Inbox';
import { Orders } from './views/Orders';
import { Settings } from './views/Settings';
import { Stats } from './views/Stats';

const TABS = [
  ['inbox', 'Розмови'],
  ['orders', 'Замовлення'],
  ['catalog', 'Каталог'],
  ['stats', 'Статистика'],
  ['settings', 'Налаштування'],
] as const;
type Tab = (typeof TABS)[number][0];

function Login({ onDone }: { onDone: () => void }) {
  // The public website's "start" buttons link here with `?mode=register`.
  const [mode, setMode] = useState<'login' | 'register'>(() => (new URLSearchParams(location.search).get('mode') === 'register' ? 'register' : 'login'));
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email'));
    const password = String(f.get('password'));
    try {
      if (mode === 'register') await api('POST', '/v1/auth/register', { email, password, displayName: String(f.get('name') || email) });
      const r = await api<{ token: string }>('POST', '/v1/auth/login', { email, password });
      token.set(r.token);
      onDone();
    } catch (x) {
      setErr(errText(x));
    }
  };
  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>Hepson</h1>
      <label>
        Email <input name="email" type="email" required autoComplete="username" />
      </label>
      {mode === 'register' && (
        <label>
          Імʼя <input name="name" />
        </label>
      )}
      <label>
        Пароль (від 10 символів) <input name="password" type="password" required minLength={10} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
      </label>
      {err && <p className="error">{err}</p>}
      <button type="submit">{mode === 'login' ? 'Увійти' : 'Зареєструватися'}</button>
      <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'Створити обліковий запис' : 'Вже є обліковий запис'}
      </button>
    </form>
  );
}

function NewShop({ onDone }: { onDone: (id: string) => void }) {
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
    <form className="card narrow" onSubmit={submit}>
      <h2>Новий магазин</h2>
      <label>
        Назва <input name="name" required maxLength={120} />
      </label>
      <label>
        Адреса (латиниця, цифри, дефіс) <input name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" minLength={2} maxLength={63} />
      </label>
      {err && <p className="error">{err}</p>}
      <button type="submit">Створити</button>
    </form>
  );
}

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
  return <Shell onLogout={() => {
    void api('POST', '/v1/auth/logout').catch((e) => e instanceof ApiError || undefined);
    token.set(null);
    setAuthed(false);
  }} />;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const shops = useLoad(() => api<Shop[]>('GET', '/v1/shops'), []);
  const [shopId, setShopId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('inbox');
  const [adding, setAdding] = useState(false);

  if (shops.error) return <p className="error card">{shops.error}</p>;
  if (!shops.data) return <p className="card">Завантаження…</p>;
  if (!shops.data.length || adding) {
    return (
      <>
        <NewShop onDone={(id) => { setAdding(false); setShopId(id); void shops.reload(); }} />
        {adding && <button className="link" onClick={() => setAdding(false)}>Скасувати</button>}
      </>
    );
  }
  const shop = shops.data.find((s) => s.shopId === shopId) ?? shops.data[0]!;

  return (
    <div className="shell">
      <header>
        <strong>Hepson</strong>
        <select value={shop.shopId} onChange={(e) => setShopId(e.target.value)} aria-label="Магазин">
          {shops.data.map((s) => (
            <option key={s.shopId} value={s.shopId}>
              {s.name} ({s.role === 'owner' ? 'власник' : 'менеджер'})
            </option>
          ))}
        </select>
        <button className="link" onClick={() => setAdding(true)}>+ магазин</button>
        <nav>
          {TABS.map(([id, label]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <button className="link" onClick={onLogout}>Вийти</button>
      </header>
      <main key={shop.shopId}>
        {tab === 'inbox' && <Inbox shop={shop} />}
        {tab === 'orders' && <Orders shop={shop} />}
        {tab === 'catalog' && <Catalog shop={shop} />}
        {tab === 'stats' && <Stats shop={shop} />}
        {tab === 'settings' && <Settings shop={shop} />}
      </main>
    </div>
  );
}
