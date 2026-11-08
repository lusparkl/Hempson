import { useEffect, useRef, useState, type FormEvent } from 'react';
import { PageHero } from '../components/Layout';
import { usePage } from '../context';
import { SITE } from '../site';
import { Button } from '../../../../packages/ui/src/components';

type Product = { name: string; description: string; priceMinor: number; currency: string };
type Result = { outcome: 'replied' | 'escalated' | 'blocked' | 'step_limit'; reply: string | null; checks: string[] };
type Turn = { role: 'customer'; text: string } | { role: 'assistant'; result: Result };

const price = (minor: number) => `${new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(minor / 100)} ₴`;

/** Live chat with the sales agent over a test catalog (D45). The page keeps the conversation; the API stores nothing. */
export function Demo() {
  const { d, dashboard } = usePage();
  const p = d.pages.demo;
  const [state, setState] = useState<'loading' | 'off' | 'on'>('loading');
  const [products, setProducts] = useState<Product[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${SITE.apiUrl}/public/demo`)
      .then((r) => r.json() as Promise<{ available: boolean; products: Product[] }>)
      .then((r) => {
        setProducts(r.products);
        setState(r.available ? 'on' : 'off');
      })
      .catch(() => setState('off'));
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [turns.length, busy]);

  const send = async (e?: FormEvent, sample?: string) => {
    e?.preventDefault();
    const t = (sample ?? text).trim();
    if (!t || busy) return;
    const next: Turn[] = [...turns, { role: 'customer', text: t }];
    setTurns(next);
    setText('');
    setError(null);
    setBusy(true);
    const messages = next
      .flatMap((x) => (x.role === 'customer' ? [{ role: 'customer', text: x.text }] : x.result.reply ? [{ role: 'assistant', text: x.result.reply }] : []))
      .slice(-20);
    try {
      const r = await fetch(`${SITE.apiUrl}/public/demo/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });
      if (!r.ok) throw new Error(r.status === 429 ? p.errors.limit : p.errors.failed);
      setTurns([...next, { role: 'assistant', result: (await r.json()) as Result }]);
    } catch (x) {
      setTurns(turns);
      setText(t);
      setError(x instanceof Error && x.message === p.errors.limit ? p.errors.limit : p.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHero eyebrow={p.eyebrow} title={p.title} intro={p.intro} />
      <section className="page-block page-last demo" aria-label={p.title}>
        {state === 'loading' && <p className="muted">{p.loading}</p>}
        {state === 'off' && <p className="muted">{p.off}</p>}
        {state === 'on' && (
          <div className="demo-grid">
            <div className="card demo-chat">
              <div className="demo-msgs" aria-live="polite">
                {!turns.length && (
                  <div className="demo-samples">
                    {p.samples.map((s) => (
                      <Button key={s} variant="secondary" size="sm" onClick={() => void send(undefined, s)}>
                        {s}
                      </Button>
                    ))}
                  </div>
                )}
                {turns.map((t, i) =>
                  t.role === 'customer' ? (
                    <div key={i} className="demo-msg demo-out">
                      {t.text}
                    </div>
                  ) : (
                    <div key={i} className="demo-reply">
                      {t.result.reply && <div className="demo-msg">{t.result.reply}</div>}
                      {t.result.outcome !== 'replied' && <div className="muted">{p.handoff}</div>}
                      {!!t.result.checks.length && (
                        <div className="muted">{`${p.checked}: ${t.result.checks.map((c) => p.checks[c as keyof typeof p.checks] ?? c).join(', ')}`}</div>
                      )}
                    </div>
                  ),
                )}
                {busy && <div className="muted">{p.thinking}</div>}
                <div ref={end} />
              </div>
              {error && <p role="alert">{error}</p>}
              <form className="demo-form" onSubmit={(e) => void send(e)}>
                <input value={text} onChange={(e) => setText(e.target.value)} placeholder={p.placeholder} aria-label={p.placeholder} maxLength={500} autoComplete="off" />
                <Button variant="primary" size="md" type="submit" disabled={busy || !text.trim()}>
                  {p.send}
                </Button>
              </form>
              <p className="muted">{p.privacy}</p>
            </div>
            <div className="card">
              <h2>{p.catalog}</h2>
              <ul className="demo-products">
                {products.map((x) => (
                  <li key={x.name}>
                    <strong>{`${x.name} — ${price(x.priceMinor)}`}</strong>
                    <p>{x.description}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <p>
          <a href={dashboard('register')}>{p.cta}</a>
        </p>
      </section>
    </>
  );
}
