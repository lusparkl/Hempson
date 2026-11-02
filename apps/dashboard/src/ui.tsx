import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../../packages/ui/src/components';
import type { Tone } from '../../../packages/ui/src/components';
import type { IconName } from '../../../packages/ui/src/icons';

export { Badge, Button, Icon, IconTile, Input, Switch, UsageMeter } from '../../../packages/ui/src/components';
export type { IconName, Tone };

/* ---------- toast ---------- */

type Say = (text: string, bad?: boolean) => void;
const ToastCtx = createContext<Say>(() => {});
export const useToast = () => useContext(ToastCtx);

/** Bottom-centre toast from the design; one message at a time, hides after 2.8 s (errors after 5 s). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ text: string; bad: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = useCallback<Say>((text, bad = false) => {
    setT({ text, bad });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setT(null), bad ? 5000 : 2800);
  }, []);
  return (
    <ToastCtx.Provider value={say}>
      {children}
      {t && (
        <div className={`toast${t.bad ? ' bad' : ''}`} role="status">
          {t.text}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

/* ---------- page actions in the top bar ---------- */

const ActionsCtx = createContext<HTMLElement | null>(null);
export const ActionsSlot = ActionsCtx.Provider;
/** Renders its children into the top bar, next to the page title (design: export / import / range controls). */
export function HeaderActions({ children }: { children: ReactNode }) {
  const node = useContext(ActionsCtx);
  return node ? createPortal(children, node) : null;
}

/* ---------- building blocks ---------- */

export function Panel({ title, meta, action, clip, children }: { title?: ReactNode; meta?: ReactNode; action?: ReactNode; clip?: boolean; children?: ReactNode }) {
  return (
    <section className={`panel${clip ? ' clip' : ''}`}>
      {title !== undefined && (
        <div className="panel-head">
          <h3 className="panel-title">{title}</h3>
          {meta !== undefined && <span className="panel-meta">{meta}</span>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

const AV: Array<[string, string]> = [
  ['var(--brand-50)', 'var(--brand-700)'],
  ['var(--warning-bg)', 'var(--warning-fg)'],
  ['var(--info-bg)', 'var(--info-fg)'],
  ['var(--success-bg)', 'var(--success-fg)'],
  ['var(--ink-100)', 'var(--ink-700)'],
];
/** Stable colour per id, from the design's five avatar tints. */
const tint = (seed: string) => {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AV[h % AV.length]!;
};
export const initial = (name: string) => (name.replace(/^@/, '').trim()[0] ?? '?').toUpperCase();

export function Avatar({ name, seed, size = 40, fontSize }: { name: string; seed?: string; size?: number; fontSize?: number }) {
  const [bg, fg] = seed === undefined ? AV[0]! : tint(seed);
  return (
    <span className="av" style={{ width: size, height: size, background: bg, color: fg, fontSize }} aria-hidden="true">
      {initial(name)}
    </span>
  );
}

export function Drawer({ title, onClose, footer, children }: { title: string; onClose: () => void; footer: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-label={title}>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer-panel">
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Закрити">
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        <div className="drawer-foot">{footer}</div>
      </div>
    </div>
  );
}

/** Sparkline path in a 96×32 box (design KPI cards). */
export function sparkPath(a: number[]) {
  if (a.length < 2) return '';
  const mn = Math.min(...a);
  const mx = Math.max(...a);
  const r = mx - mn || 1;
  return a.map((v, i) => (i ? 'L' : 'M') + ((i * 96) / (a.length - 1)).toFixed(1) + ',' + (28 - ((v - mn) / r) * 24).toFixed(1)).join('');
}

export function Spark({ data }: { data: number[] | null }) {
  // null = no per-day series in the API yet (P10): a flat dashed line keeps the card layout.
  return (
    <svg width="96" height="32" viewBox="0 0 96 32" fill="none" style={{ flex: '0 1 96px', minWidth: 48 }} aria-hidden="true">
      {data && data.length > 1 ? (
        <path d={sparkPath(data)} stroke="var(--brand-600)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M0,22L96,22" stroke="var(--ink-200)" strokeWidth="1.5" strokeDasharray="3 4" />
      )}
    </svg>
  );
}

export function FunnelRows({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="funnel">
      {rows.map((f, i) => (
        <div key={f.label} className="funnel-row">
          <span className="muted">{f.label}</span>
          <div className="funnel-track">
            <div style={{ height: '100%', borderRadius: 2, width: `${Math.round((f.value / max) * 100)}%`, background: i === 0 ? 'var(--brand-300)' : 'var(--brand-600)' }} />
          </div>
          <strong>{f.value}</strong>
        </div>
      ))}
    </div>
  );
}

export function Alert({ tone = 'danger', icon = 'circle-alert', children }: { tone?: 'danger' | 'warning' | 'info'; icon?: IconName; children: ReactNode }) {
  return (
    <div className={`alert ${tone}`}>
      <Icon name={icon} size={16} />
      <span>{children}</span>
    </div>
  );
}

export function Textarea({ label, ...rest }: { label?: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const el = <textarea className="field" rows={4} {...rest} />;
  return label ? (
    <label style={{ display: 'block' }}>
      <span className="lbl-text">{label}</span>
      {el}
    </label>
  ) : (
    el
  );
}

export function Select({ label, children, ...rest }: { label: string } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="hs-field">
      <label className="hs-label" htmlFor={rest.id ?? rest.name}>
        {label}
      </label>
      <div className="hs-select">
        <select id={rest.id ?? rest.name} className="hs-input" {...rest}>
          {children}
        </select>
      </div>
    </div>
  );
}

/** Wraps an async action: shows "Зміни збережено" (or the given text) on success and the error on failure. */
export function useRun() {
  const say = useToast();
  return useCallback(
    async (fn: () => Promise<unknown>, ok: string | null = 'Зміни збережено') => {
      try {
        await fn();
        if (ok) say(ok);
        return true;
      } catch (e) {
        say(e instanceof Error ? e.message : String(e), true);
        return false;
      }
    },
    [say],
  );
}
