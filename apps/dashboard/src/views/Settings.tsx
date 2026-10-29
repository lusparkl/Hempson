import { useState, type FormEvent } from 'react';
import { api, errText, useLoad, type Shop } from '../api';

type Ai = { enabled: boolean; instructions: string; available: boolean };
type Notify = { telegram: { available: boolean; chatId: string | null } };
type Web = { enabled: boolean; widgetKey: string | null; allowedOrigins: string[]; snippet: string | null };
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
      <AiCard base={base} owner={owner} />
      <WebCard base={base} owner={owner} />
      <TelegramCard base={base} owner={owner} />
      <TeamCard base={base} owner={owner} />
    </div>
  );
}

function AiCard({ base, owner }: { base: string; owner: boolean }) {
  const ai = useLoad(() => api<Ai>('GET', `${base}/ai`), [base]);
  const s = useSave();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void s.run(async () => {
      await api('PUT', `${base}/ai`, { enabled: f.get('enabled') === 'on', instructions: String(f.get('instructions') ?? '') });
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
      {owner && <button type="submit">Зберегти</button>} <Note m={s.msg} />
    </form>
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
