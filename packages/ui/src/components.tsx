import type { AnchorHTMLAttributes, ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode } from 'react';
import { ICONS, type IconName } from './icons';

/** Core components of the Hepson design system (Button, Badge, Input, Switch, IconTile, UsageMeter, Icon, Logo). */

export function Icon({ name, size = 20, style, label }: { name: IconName; size?: number; style?: CSSProperties; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ display: 'inline-block', flex: 'none', ...style }}
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

type BtnBase = { variant?: 'primary' | 'secondary'; size?: 'sm' | 'md' | 'lg'; arrow?: boolean; icon?: IconName; children?: ReactNode };

export function Button({ variant = 'primary', size = 'lg', arrow, icon, className = '', children, type = 'button', ...rest }: BtnBase & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={`hs-btn hs-btn--${variant} hs-btn--${size} ${className}`} {...rest}>
      {icon && <Icon name={icon} size={16} />}
      {children}
      {arrow && <span className="hs-chev" aria-hidden="true" />}
    </button>
  );
}

export function ButtonLink({ variant = 'primary', size = 'lg', arrow, icon, className = '', children, ...rest }: BtnBase & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={`hs-btn hs-btn--${variant} hs-btn--${size} ${className}`} {...rest}>
      {icon && <Icon name={icon} size={16} />}
      {children}
      {arrow && <span className="hs-chev" aria-hidden="true" />}
    </a>
  );
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={'hs-badge' + (tone === 'neutral' ? '' : ` hs-badge--${tone}`)}>{children}</span>;
}

export function Input({ label, hint, error, id, className = '', ...rest }: { label?: string; hint?: string; error?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const i = id ?? `in-${(label ?? rest.name ?? '').replace(/\W/g, '')}`;
  return (
    <div className="hs-field">
      {label && (
        <label className="hs-label" htmlFor={i}>
          {label}
        </label>
      )}
      <input id={i} className={`hs-input${error ? ' hs-input--error' : ''} ${className}`} aria-invalid={error ? true : undefined} {...rest} />
      {(error || hint) && <span className={`hs-hint${error ? ' hs-hint--error' : ''}`}>{error || hint}</span>}
    </div>
  );
}

export function Switch({ label, ...rest }: { label?: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <label className="hs-switch">
      <input type="checkbox" role="switch" {...rest} />
      <span className="hs-switch__track" />
      {label}
    </label>
  );
}

export function IconTile({ icon }: { icon: IconName }) {
  return (
    <span className="hs-icontile">
      <Icon name={icon} size={18} />
    </span>
  );
}

export function UsageMeter({ label, value, max = 100, valueLabel }: { label: string; value: number; max?: number; valueLabel?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="hs-meter">
      <div className="hs-meter__row">
        <span>{label}</span>
        {valueLabel && <span>{valueLabel}</span>}
      </div>
      <div className="hs-meter__track" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
        <div className="hs-meter__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** The "h" mark: indigo rounded square with the white monoline letter. */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true" style={{ flex: 'none' }}>
      <rect width="48" height="48" rx="10" fill="var(--brand-600)" />
      <path d="M16 9V39" stroke="#fff" strokeWidth="5.5" />
      <path d="M16 27C16 21 20 18 25 18C30.5 18 33 21.5 33 26V39" stroke="#fff" strokeWidth="5.5" strokeLinejoin="round" />
    </svg>
  );
}

/** Mark + "hepson" wordmark; `size` is the mark size, the text scales with it. */
export function Logo({ size = 30, href, label = 'Hepson — на головну', textClass }: { size?: number; href?: string; label?: string; textClass?: string }) {
  const body = (
    <>
      <LogoMark size={size} />
      <span className={textClass} style={{ fontSize: Math.round(size * 0.8) }}>
        hepson
      </span>
    </>
  );
  return href ? (
    <a className="hs-wordmark" href={href} aria-label={label}>
      {body}
    </a>
  ) : (
    <span className="hs-wordmark">{body}</span>
  );
}
