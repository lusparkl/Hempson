import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useShop } from '../App';
import { ApiError, api, errText, type AiSettings } from '../api';
import { Alert, Button, Icon, Textarea, useRun, useToast } from '../ui';

type Tool = { name: string; arguments: string; result: string };
type Result = { outcome: 'replied' | 'escalated' | 'blocked' | 'step_limit'; reply: string | null; escalation: string | null; blocked: string[]; tools: Tool[] };
type Turn = { role: 'customer'; text: string } | { role: 'assistant'; result: Result };

const TOOL_LABEL: Record<string, string> = {
  search_products: 'Пошук у каталозі',
  get_variant: 'Ціна й залишок варіанта',
  suggest_products: 'Схожі товари',
  quote_order: 'Розрахунок суми',
  get_policy: 'Умови магазину',
  find_np_city: 'Пошук міста НП',
  find_np_branch: 'Пошук відділення НП',
  get_checkout_options: 'Способи оплати',
  create_order_draft: 'Чернетка замовлення (тест)',
  get_order_status: 'Статус замовлення',
  escalate: 'Передати менеджеру',
};
const SAMPLES = ['Скільки коштує і чи є в наявності?', 'Які умови доставки?', 'Можна повернути, якщо не підійде?', 'Хочу оформити замовлення'];

/** `query: худі · limit: 3` from the tool's JSON arguments. */
const argsText = (raw: string) => {
  try {
    const o = JSON.parse(raw || '{}') as Record<string, unknown>;
    return Object.entries(o)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' · ');
  } catch {
    return raw;
  }
};
const pretty = (raw: string) => {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};
const failed = (raw: string) => {
  try {
    return 'error' in (JSON.parse(raw) as object);
  } catch {
    return true;
  }
};

const playErr = (e: unknown) =>
  e instanceof ApiError && e.status === 429
    ? 'Забагато тестових повідомлень. Спробуйте за кілька хвилин.'
    : e instanceof ApiError && e.code === 'TEMPORARY_FAILURE'
      ? 'Модель не відповіла. Спробуйте ще раз.'
      : errText(e);

/** The owner's test chat with their own assistant (same prompt, catalog, policies and checks); nothing reaches a customer. */
export function Playground() {
  const { shop, ai, refresh, go } = useShop();
  const base = `/v1/shops/${shop.shopId}`;
  const owner = shop.role === 'owner';
  const say = useToast();
  const run = useRun();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, busy]);

  const saved = ai?.instructions ?? '';
  const draft = notes ?? saved;
  const dirty = notes !== null && notes !== saved;
  const lastAi = [...turns.keys()].reverse().find((i) => turns[i]!.role === 'assistant');
  const shown = picked ?? lastAi;
  const shownTurn = shown === undefined ? undefined : turns[shown];
  const trace = shownTurn?.role === 'assistant' ? shownTurn.result.tools : null;

  const send = async (e?: FormEvent, sample?: string) => {
    e?.preventDefault();
    const t = (sample ?? text).trim();
    if (!t || busy) return;
    const next: Turn[] = [...turns, { role: 'customer', text: t }];
    setTurns(next);
    setText('');
    setBusy(true);
    // Only what a customer would have seen goes back as history: replies that passed the checks.
    const messages = next.flatMap((x) => (x.role === 'customer' ? [{ role: 'customer', text: x.text }] : x.result.reply ? [{ role: 'assistant', text: x.result.reply }] : []));
    try {
      const result = await api<Result>('POST', `${base}/ai/playground`, { messages, ...(dirty ? { instructions: draft } : {}) });
      setTurns([...next, { role: 'assistant', result }]);
      setPicked(null);
    } catch (x) {
      setTurns(turns);
      setText(t);
      say(playErr(x), true);
    } finally {
      setBusy(false);
    }
  };
  const saveNotes = () =>
    void run(async () => {
      await api<AiSettings>('PUT', `${base}/ai`, { instructions: draft });
      setNotes(null);
      refresh();
    });

  if (ai && !ai.available)
    return (
      <div className="page">
        <Alert>На сервері не налаштовано модель (OPENAI_API_KEY, HEPSON_OPENAI_MODEL): тестовий чат недоступний.</Alert>
      </div>
    );

  return (
    <div className="play">
      <section className="thread">
        <div className="thread-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, color: 'var(--ink-900)' }}>Тестовий чат</div>
            <div style={{ fontSize: 13 }} className="subtle">
              Пишіть як клієнт. Клієнти цього не бачать; замовлення, ескалації й сповіщення не створюються.
            </div>
          </div>
          <Button variant="secondary" size="sm" disabled={!turns.length || busy} onClick={() => (setTurns([]), setPicked(null))}>
            <Icon name="refresh-cw" size={14} /> Почати знову
          </Button>
        </div>
        <div className="msgs">
          {ai && !ai.enabled && (
            <Alert tone="info" icon="pause">
              Асистент зараз не відповідає клієнтам. Перевірте його тут, а потім увімкніть у{' '}
              <button type="button" className="linkbtn" onClick={() => go('settings', { tab: 'ai' })}>
                Налаштуваннях
              </button>
              .
            </Alert>
          )}
          {!turns.length && (
            <div className="play-empty">
              <Icon name="sparkles" size={22} />
              <div className="muted">Спитайте те, що зазвичай питають ваші клієнти. Асистент бачить ваш каталог, умови магазину й інструкції.</div>
              <div className="pills" style={{ justifyContent: 'center' }}>
                {SAMPLES.map((s) => (
                  <button key={s} type="button" className="pill" onClick={() => void send(undefined, s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t, i) => {
            if (t.role === 'customer')
              return (
                <div key={i} className="msg out">
                  <div className="msg-who">Ви як клієнт</div>
                  <div className="bubble human">{t.text}</div>
                </div>
              );
            const r = t.result;
            return (
              <div key={i} style={{ display: 'contents' }}>
                {r.reply && (
                  <div className="msg">
                    <div className="msg-who">ШІ-асистент</div>
                    <button type="button" className="bubble ai play-reply" aria-pressed={shown === i} onClick={() => setPicked(i)} title="Показати, що перевірив асистент">
                      {r.reply}
                      {!!r.tools.length && <div className="bubble-time">Перевірок: {r.tools.length}</div>}
                    </button>
                  </div>
                )}
                {r.outcome === 'escalated' && (
                  <div className="sys warn">
                    <Icon name="hand" size={14} />
                    Розмову передано б менеджеру: {r.escalation}. Далі асистент мовчав би, доки ескалацію не закриють.
                  </div>
                )}
                {(r.outcome === 'blocked' || r.outcome === 'step_limit') && (
                  <button type="button" className="sys warn" onClick={() => setPicked(i)}>
                    <Icon name="shield-check" size={14} />
                    {r.outcome === 'blocked' ? 'Відповідь не пройшла перевірку й не була б надіслана' : 'Асистент не впорався з відповіддю'}; розмову отримав би менеджер.
                  </button>
                )}
              </div>
            );
          })}
          {busy && (
            <div className="msg">
              <div className="msg-who">ШІ-асистент</div>
              <div className="bubble ai subtle">Думає…</div>
            </div>
          )}
          <div ref={end} />
        </div>
        <div className="composer">
          <form onSubmit={(e) => void send(e)}>
            <input
              className="field"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Повідомлення від імені клієнта…"
              maxLength={1000}
              autoComplete="off"
              aria-label="Повідомлення від імені клієнта"
            />
            <Button variant="primary" size="md" type="submit" disabled={busy || !text.trim()}>
              Надіслати <Icon name="send" size={16} />
            </Button>
          </form>
          <div style={{ fontSize: 12 }} className="subtle">
            Не враховується в ліміт відповідей ШІ. Фото в тесті не підтримуються.
          </div>
        </div>
      </section>
      <aside className="inbox-side play-side">
        <div className="side-block" style={{ borderTop: 0, paddingTop: 0 }}>
          <h3 className="panel-title">Що перевірив асистент</h3>
          {shownTurn?.role === 'assistant' && shownTurn.result.blocked.length > 0 && (
            <Alert tone="warning">Перевірка зупинила відповідь: {shownTurn.result.blocked.join(' ')}</Alert>
          )}
          {!trace?.length ? (
            <div style={{ fontSize: 14 }} className="subtle">
              {trace ? 'Для цієї відповіді асистент нічого не шукав.' : 'Тут з’являться пошуки в каталозі, умови й розрахунки, на які спирається відповідь.'}
            </div>
          ) : (
            trace.map((c, i) => (
              <details key={i} className="trace">
                <summary>
                  <span className={failed(c.result) ? 'err' : undefined}>{TOOL_LABEL[c.name] ?? c.name}</span>
                  {argsText(c.arguments) && <span className="subtle ellipsis">{argsText(c.arguments)}</span>}
                </summary>
                <pre>{pretty(c.result)}</pre>
              </details>
            ))
          )}
        </div>
        <div className="side-block">
          <h3 className="panel-title">Інструкції для тесту</h3>
          <div className="s-desc">Змініть і перевірте тут; клієнти отримають їх лише після збереження.</div>
          <Textarea
            aria-label="Інструкції для тесту"
            rows={5}
            maxLength={2000}
            value={draft}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Тон спілкування, особливості вашого бізнесу"
          />
          {dirty && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {owner && (
                <Button variant="primary" size="sm" onClick={saveNotes}>
                  Зберегти для клієнтів
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => setNotes(null)}>
                Скасувати зміни
              </Button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
