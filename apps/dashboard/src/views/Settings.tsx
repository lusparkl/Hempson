import { useState, type FormEvent } from 'react';
import { api, errText, useLoad, when, type Shop } from '../api';

type Ai = { enabled: boolean; instructions: string; available: boolean; autonomy: 'approval_required' | 'auto_confirm'; autoConfirmMaxMinor: number | null; autonomyChangedAt: string | null };
type Policy = { topic: 'delivery' | 'returns' | 'payment' | 'hours'; text: string; version: number; updatedAt: string | null };
type Np = {
  available: boolean;
  status: 'not_connected' | 'connected' | 'needs_reconnect';
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
type NpCity = { ref: string; name: string; area: string | null };
type NpBranch = { ref: string; number: string | null; name: string };
type Notify = { telegram: { available: boolean; chatId: string | null } };
type Web = { enabled: boolean; widgetKey: string | null; allowedOrigins: string[]; snippet: string | null };
type Ig = { available: boolean; status: 'not_connected' | 'connected' | 'needs_reconnect'; username: string | null; tokenExpiresAt: string | null; lastError: string | null };
type Tg = { available: boolean; status: 'not_connected' | 'connected' | 'needs_reconnect'; botUsername: string | null; lastError: string | null };
type Member = { userId: string; email: string; displayName: string; role: string };

function useSave() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return {
    msg,
    run: async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        setMsg({ ok: true, text: 'Збережено' });
      } catch (e) {
        setMsg({ ok: false, text: errText(e) });
      }
    },
  };
}
const Note = ({ m }: { m: { ok: boolean; text: string } | null }) => (m ? <span className={m.ok ? 'muted' : 'error'}>{m.text}</span> : null);

export function Settings({ shop }: { shop: Shop }) {
  const base = `/v1/shops/${shop.shopId}`;
  const owner = shop.role === 'owner';
  return (
    <div className="stack">
      {!owner && <p className="muted">Змінювати налаштування може лише власник.</p>}
      <InstagramCard base={base} owner={owner} />
      <TelegramBotCard base={base} owner={owner} />
      <AiCard base={base} owner={owner} />
      <PoliciesCard base={base} owner={owner} />
      <NovaPoshtaCard base={base} owner={owner} />
      <WebCard base={base} owner={owner} />
      <TelegramCard base={base} owner={owner} />
      <TeamCard base={base} owner={owner} />
    </div>
  );
}

const IG_RESULT: Record<string, string> = {
  connected: 'Instagram підключено.',
  denied: 'Доступ у Instagram не надано.',
  taken: 'Цей Instagram-акаунт уже підключений до іншого магазину.',
  select_one: 'Під час входу потрібно вибрати рівно один Instagram-акаунт. Підключіть ще раз.',
  error: 'Не вдалося підключити Instagram. Спробуйте ще раз.',
};

function InstagramCard({ base, owner }: { base: string; owner: boolean }) {
  const ig = useLoad(() => api<Ig>('GET', `${base}/instagram`), [base]);
  const s = useSave();
  const result = IG_RESULT[new URLSearchParams(window.location.search).get('instagram') ?? ''];
  if (!ig.data) return <section className="card">{ig.error ?? '…'}</section>;
  const d = ig.data;
  const connect = () =>
    void s.run(async () => {
      const r = await api<{ authorizeUrl: string }>('POST', `${base}/instagram/connect`);
      window.location.assign(r.authorizeUrl);
    });
  const disconnect = () =>
    window.confirm('Відключити Instagram? Токен буде видалено, відповіді в Instagram припиняться.') &&
    void s.run(async () => {
      await api('DELETE', `${base}/instagram`);
      await ig.reload();
    });
  return (
    <section className="card">
      <h2>Instagram</h2>
      {result && <p className="muted">{result}</p>}
      {!d.available && <p className="error">Сервер не налаштований для Instagram (ключі Meta-застосунку та HEPSON_MASTER_KEY).</p>}
      {d.status === 'connected' && <p>Підключено{d.username ? `: @${d.username}` : ''}. {d.tokenExpiresAt ? `Токен діє до ${new Date(d.tokenExpiresAt).toLocaleDateString('uk-UA')}.` : 'Токен без строку дії.'}</p>}
      {d.status === 'needs_reconnect' && <p className="error">Потрібно підключити знову: токен більше не діє. Відповіді в Instagram не надсилаються.</p>}
      {d.status === 'not_connected' && <p className="muted">Не підключено. Потрібен професійний акаунт Instagram.</p>}
      {d.lastError && d.status === 'connected' && <p className="error">Є проблема: {d.lastError}</p>}
      {owner && d.available && (
        <>
          <button type="button" onClick={connect}>{d.status === 'connected' ? 'Підключити знову' : 'Підключити Instagram'}</button>{' '}
          {d.status !== 'not_connected' && <button type="button" onClick={disconnect}>Відключити</button>}
        </>
      )}{' '}
      <Note m={s.msg} />
    </section>
  );
}

function TelegramBotCard({ base, owner }: { base: string; owner: boolean }) {
  const tg = useLoad(() => api<Tg>('GET', `${base}/telegram`), [base]);
  const s = useSave();
  if (!tg.data) return <section className="card">{tg.error ?? '…'}</section>;
  const d = tg.data;
  const connect = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const token = String(new FormData(form).get('token') ?? '');
    void s.run(async () => {
      await api('PUT', `${base}/telegram`, { token });
      form.reset();
      await tg.reload();
    });
  };
  const disconnect = () =>
    window.confirm('Відключити Telegram-бота? Токен буде видалено, відповіді в Telegram припиняться.') &&
    void s.run(async () => {
      await api('DELETE', `${base}/telegram`);
      await tg.reload();
    });
  return (
    <section className="card">
      <h2>Telegram-бот для клієнтів</h2>
      {!d.available && <p className="error">Сервер не налаштований для Telegram (HEPSON_MASTER_KEY та HTTPS-адреса HEPSON_PUBLIC_URL).</p>}
      {d.status === 'connected' && <p>Підключено{d.botUsername ? `: @${d.botUsername}` : ''}.</p>}
      {d.status === 'needs_reconnect' && <p className="error">Потрібно підключити знову: токен більше не діє. Відповіді в Telegram не надсилаються.</p>}
      {d.status === 'not_connected' && <p className="muted">Не підключено. Створіть бота в @BotFather і вставте його токен.</p>}
      {owner && d.available && (
        <form className="row" onSubmit={connect}>
          <input name="token" type="password" autoComplete="off" placeholder="токен бота від @BotFather" required />
          <button type="submit">{d.status === 'not_connected' ? 'Підключити' : 'Замінити токен'}</button>
          {d.status !== 'not_connected' && <button type="button" onClick={disconnect}>Відключити</button>}
        </form>
      )}
      <Note m={s.msg} />
    </section>
  );
}

function AiCard({ base, owner }: { base: string; owner: boolean }) {
  const ai = useLoad(() => api<Ai>('GET', `${base}/ai`), [base]);
  const s = useSave();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void s.run(async () => {
      const cap = String(f.get('cap') ?? '').trim().replace(',', '.');
      await api('PUT', `${base}/ai`, {
        enabled: f.get('enabled') === 'on',
        instructions: String(f.get('instructions') ?? ''),
        autonomy: f.get('autonomy') === 'auto_confirm' ? 'auto_confirm' : 'approval_required',
        autoConfirmMaxMinor: cap ? Math.round(Number(cap) * 100) : null,
      });
      await ai.reload();
    });
  };
  if (!ai.data) return <section className="card">{ai.error ?? '…'}</section>;
  return (
    <form className="card" onSubmit={submit} key={JSON.stringify(ai.data)}>
      <h2>ШІ-асистент</h2>
      {!ai.data.available && <p className="error">На сервері не налаштовано модель (OPENAI_API_KEY, HEPSON_OPENAI_MODEL): асистент не працюватиме.</p>}
      <label className="check"><input type="checkbox" name="enabled" defaultChecked={ai.data.enabled} disabled={!owner} /> Асистент відповідає клієнтам</label>
      <label>Додаткові інструкції (тон, правила; не скасовують жорсткі правила) <textarea name="instructions" rows={4} maxLength={2000} defaultValue={ai.data.instructions} disabled={!owner} /></label>
      <label>
        Підтвердження замовлень
        <select name="autonomy" defaultValue={ai.data.autonomy} disabled={!owner}>
          <option value="approval_required">Кожне замовлення підтверджує людина</option>
          <option value="auto_confirm">Автоматично, якщо всі перевірки пройдено</option>
        </select>
      </label>
      <label>Ліміт суми для автопідтвердження, грн (порожньо — без ліміту) <input name="cap" inputMode="decimal" defaultValue={ai.data.autoConfirmMaxMinor === null ? '' : String(ai.data.autoConfirmMaxMinor / 100)} disabled={!owner} /></label>
      {ai.data.autonomyChangedAt && <p className="muted">Режим змінено: {when(ai.data.autonomyChangedAt)}</p>}
      {owner && <button type="submit">Зберегти</button>} <Note m={s.msg} />
    </form>
  );
}

const POLICY_LABEL: Record<Policy['topic'], string> = { delivery: 'Доставка (терміни, вартість)', returns: 'Повернення та обмін', payment: 'Оплата', hours: 'Графік роботи' };

/** Texts the AI may quote. A topic without text makes the AI hand the question to a person. */
function PoliciesCard({ base, owner }: { base: string; owner: boolean }) {
  const p = useLoad(() => api<{ items: Policy[] }>('GET', `${base}/policies`), [base]);
  const s = useSave();
  if (!p.data) return <section className="card">{p.error ?? '…'}</section>;
  const save = (topic: Policy['topic']) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = String(new FormData(e.currentTarget).get('text') ?? '');
    void s.run(async () => {
      await api('PUT', `${base}/policies/${topic}`, { text });
      await p.reload();
    });
  };
  return (
    <section className="card">
      <h2>Правила магазину для ШІ</h2>
      <p className="muted">ШІ відповідає про доставку, повернення, оплату й графік лише цими словами. Порожнє поле — ШІ передає питання людині.</p>
      {p.data.items.map((x) => (
        <form key={`${x.topic}:${x.version}`} onSubmit={save(x.topic)}>
          <label>
            {POLICY_LABEL[x.topic]} {x.version > 0 && <span className="muted">(версія {x.version})</span>}
            <textarea name="text" rows={3} maxLength={4000} defaultValue={x.text} disabled={!owner} />
          </label>
          {owner && <button type="submit">Зберегти</button>}
        </form>
      ))}
      <Note m={s.msg} />
    </section>
  );
}

function NovaPoshtaCard({ base, owner }: { base: string; owner: boolean }) {
  const np = useLoad(() => api<Np>('GET', `${base}/nova-poshta`), [base]);
  const s = useSave();
  const [cities, setCities] = useState<NpCity[]>([]);
  const [city, setCity] = useState<NpCity | null>(null);
  const [branches, setBranches] = useState<NpBranch[]>([]);
  if (!np.data) return <section className="card">{np.error ?? '…'}</section>;
  const d = np.data;
  const connect = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const apiKey = String(new FormData(form).get('apiKey') ?? '').trim();
    void s.run(async () => {
      await api('PUT', `${base}/nova-poshta/key`, { apiKey });
      form.reset();
      await np.reload();
    });
  };
  const findCity = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    void s.run(async () => setCities((await api<{ items: NpCity[] }>('GET', `${base}/nova-poshta/cities?q=${encodeURIComponent(q)}`)).items));
  };
  const pickCity = (c: NpCity) =>
    void s.run(async () => {
      setCity(c);
      setCities([]);
      setBranches((await api<{ items: NpBranch[] }>('GET', `${base}/nova-poshta/branches?cityRef=${encodeURIComponent(c.ref)}&q=`)).items);
    });
  const pickBranch = (b: NpBranch) =>
    void s.run(async () => {
      await api('PUT', `${base}/nova-poshta/settings`, { senderCityRef: city!.ref, senderCityName: city!.name, senderWarehouseRef: b.ref, senderWarehouseName: b.name });
      setCity(null);
      setBranches([]);
      await np.reload();
    });
  const saveSettings = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void s.run(async () => {
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
  return (
    <section className="card">
      <h2>Нова Пошта</h2>
      {!d.available && <p className="error">Сервер не налаштований для збереження ключів (HEPSON_MASTER_KEY).</p>}
      {d.status === 'connected' && <p>Ключ підключено{d.senderPhone ? `, відправник ${d.senderPhone}` : ''}.</p>}
      {d.status === 'needs_reconnect' && <p className="error">Нова Пошта не приймає ключ. Введіть ключ знову: поки цього не зроблено, ТТН не створюються.</p>}
      {d.status === 'not_connected' && <p className="muted">Не підключено. Без ключа ШІ не оформлює замовлення. Ключ створюється в кабінеті НП: Налаштування → Безпека → API-ключ.</p>}
      {owner && d.available && (
        <form className="row" onSubmit={connect}>
          <input name="apiKey" type="password" autoComplete="off" placeholder="API-ключ Нової Пошти" required />
          <button type="submit">{d.status === 'not_connected' ? 'Підключити' : 'Замінити ключ'}</button>
          {d.status !== 'not_connected' && (
            <button type="button" onClick={() => window.confirm('Видалити ключ Нової Пошти?') && void s.run(async () => { await api('DELETE', `${base}/nova-poshta/key`); await np.reload(); })}>
              Видалити ключ
            </button>
          )}
        </form>
      )}
      <p>
        Відділення відправки: {d.senderCityName && d.senderWarehouseName ? `${d.senderCityName}, ${d.senderWarehouseName}` : <span className="error">не вибрано (ТТН не створюватимуться)</span>}
      </p>
      {owner && d.status === 'connected' && (
        <>
          <form className="row" onSubmit={findCity}>
            <input name="q" placeholder="Місто відправки" minLength={2} required />
            <button type="submit">Знайти</button>
          </form>
          {cities.map((c) => (
            <button key={c.ref} type="button" onClick={() => pickCity(c)}>{c.name}{c.area ? ` (${c.area})` : ''}</button>
          ))}
          {city && branches.length === 0 && <p className="muted">У цьому місті не знайдено робочих відділень.</p>}
          {branches.map((b) => (
            <button key={b.ref} type="button" onClick={() => pickBranch(b)}>{b.name}</button>
          ))}
        </>
      )}
      <form onSubmit={saveSettings} key={JSON.stringify(d)}>
        <label className="check"><input type="checkbox" name="cod" defaultChecked={d.codEnabled} disabled={!owner} /> Накладений платіж</label>
        <label className="check"><input type="checkbox" name="prepaid" defaultChecked={d.prepaidEnabled} disabled={!owner} /> Передоплата (реквізити надсилає менеджер; посилання на оплату з'являться пізніше)</label>
        <label>
          Відмов від посилок, після яких клієнту не пропонується накладений платіж
          <select name="refusalLimit" defaultValue={String(d.refusalLimit)} disabled={!owner}>
            <option value="0">Не обмежувати</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </label>
        <label>Вага посилки, кг <input name="weight" defaultValue={d.parcelWeightKg} disabled={!owner} /></label>
        <label>Опис вмісту для ТТН <input name="description" maxLength={100} defaultValue={d.parcelDescription} disabled={!owner} /></label>
        {owner && <button type="submit">Зберегти</button>}
      </form>
      <Note m={s.msg} />
    </section>
  );
}

function WebCard({ base, owner }: { base: string; owner: boolean }) {
  const w = useLoad(() => api<Web>('GET', `${base}/web-chat`), [base]);
  const s = useSave();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const allowedOrigins = String(f.get('origins') ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
    void s.run(async () => {
      await api('PUT', `${base}/web-chat`, { enabled: f.get('enabled') === 'on', allowedOrigins });
      await w.reload();
    });
  };
  if (!w.data) return <section className="card">{w.error ?? '…'}</section>;
  return (
    <form className="card" onSubmit={submit} key={JSON.stringify(w.data)}>
      <h2>Чат на сайті</h2>
      <label className="check"><input type="checkbox" name="enabled" defaultChecked={w.data.enabled} disabled={!owner} /> Чат увімкнено</label>
      <label>
        Дозволені сайти (по одному в рядок, напр. https://shop.example)
        <textarea name="origins" rows={3} defaultValue={w.data.allowedOrigins.join('\n')} disabled={!owner} />
      </label>
      {owner && <button type="submit">Зберегти</button>} <Note m={s.msg} />
      {w.data.snippet && (
        <>
          <p className="muted">Вставте перед &lt;/body&gt; на дозволеному сайті:</p>
          <pre>{w.data.snippet}</pre>
          {owner && <button type="button" onClick={() => window.confirm('Старий код перестане працювати. Продовжити?') && void s.run(async () => { await api('POST', `${base}/web-chat/rotate-key`); await w.reload(); })}>Новий ключ</button>}
        </>
      )}
    </form>
  );
}

function TelegramCard({ base, owner }: { base: string; owner: boolean }) {
  const n = useLoad(() => api<Notify>('GET', `${base}/notifications`), [base]);
  const s = useSave();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = String(new FormData(e.currentTarget).get('chat') ?? '').trim();
    void s.run(async () => {
      await api('PUT', `${base}/notifications`, { telegramChatId: v || null });
      await n.reload();
    });
  };
  if (!n.data) return <section className="card">{n.error ?? '…'}</section>;
  return (
    <form className="card" onSubmit={submit} key={JSON.stringify(n.data)}>
      <h2>Сповіщення в Telegram</h2>
      {!n.data.telegram.available && <p className="error">На сервері не задано HEPSON_TELEGRAM_BOT_TOKEN: сповіщення не надсилаються.</p>}
      <label>Chat id або @канал (порожньо — вимкнено) <input name="chat" defaultValue={n.data.telegram.chatId ?? ''} disabled={!owner} /></label>
      {owner && <button type="submit">Зберегти</button>} <Note m={s.msg} />
    </form>
  );
}

function TeamCard({ base, owner }: { base: string; owner: boolean }) {
  const m = useLoad(() => api<Member[]>('GET', `${base}/members`), [base]);
  const s = useSave();
  const add = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void s.run(async () => {
      await api('POST', `${base}/members`, { email: String(f.get('email')), role: String(f.get('role')) });
      form.reset();
      await m.reload();
    });
  };
  return (
    <section className="card">
      <h2>Команда</h2>
      <ul>
        {m.data?.map((x) => (
          <li key={x.userId}>
            {x.displayName} — {x.email} ({x.role === 'owner' ? 'власник' : 'менеджер'})
          </li>
        ))}
      </ul>
      {owner && (
        <form className="row" onSubmit={add}>
          <input name="email" type="email" placeholder="email зареєстрованого користувача" required />
          <select name="role" defaultValue="manager">
            <option value="manager">менеджер</option>
            <option value="owner">власник</option>
          </select>
          <button type="submit">Додати</button>
        </form>
      )}
      <Note m={s.msg} />
    </section>
  );
}
