import type { ReactNode } from 'react';
import { CtaBg } from '../../../../packages/ui/src/embeds/CtaBg';
import { HeroEmbed } from '../../../../packages/ui/src/embeds/HeroEmbed';
import { HowEmbed } from '../../../../packages/ui/src/embeds/HowEmbed';
import { Badge, ButtonLink, Icon, IconTile, UsageMeter, type Tone } from '../../../../packages/ui/src/components';
import type { IconName } from '../../../../packages/ui/src/icons';
import { AnimSlot } from '../components/AnimSlot';
import { fmt, usePage } from '../context';

/** Home page, after the "Hepson Home v2" design. Copy lives in `d.pages.home`; demo cards use sample data. */
export function Home() {
  const { d, dashboard, href } = usePage();
  const h = d.pages.home;
  const f = h.features;
  return (
    <div className="hs-rails">
      <section id="top" className="hm-hero" aria-labelledby="hero-title">
        <AnimSlot id="hero.intro" className="hm-hero-copy">
          <div className="hm-hero-eyebrow">{h.hero.eyebrow}</div>
          <h1 id="hero-title">
            {h.hero.title} <span>{h.hero.subtitle}</span>
          </h1>
          <div className="hm-actions">
            <ButtonLink variant="primary" size="lg" arrow href={dashboard('register')}>
              {h.hero.primaryCta}
            </ButtonLink>
            <ButtonLink variant="secondary" size="lg" href={href('demo')}>
              {d.common.nav.demo}
            </ButtonLink>
          </div>
          <div className="hm-note">{h.hero.note}</div>
        </AnimSlot>
        <AnimSlot id="hero.chat-demo" className="hm-hero-art">
          <HeroEmbed />
        </AnimSlot>
      </section>

      <section className="hm-strip" aria-labelledby="channels-title">
        <h2 id="channels-title" className="hm-strip-title">
          {h.channels.title}
        </h2>
        <AnimSlot id="channels.icons" className="hm-marquee-mask">
          <div className="hm-marquee">
            {[0, 1].map((k) => (
              <div key={k} className="hm-marquee-row" aria-hidden={k === 1 ? true : undefined}>
                <Logo src="/logos/instagram.svg" alt="Instagram" name="Instagram" />
                <Logo src="/logos/telegram.svg" alt="Telegram" name="Telegram" />
                <Logo src="/logos/nova-poshta.svg" alt="Нова Пошта" />
                <Logo src="/logos/monobank.svg" alt="monobank" name="monobank" />
                <div className="hm-item">
                  <svg
                    className="hm-chat"
                    width="36"
                    height="36"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M4 5h16v11H10l-4 4v-4H4z" />
                    <path d="M9 10.5h.01M12 10.5h.01M15 10.5h.01" />
                  </svg>
                  <span className="hm-name">{h.channels.webChat}</span>
                </div>
              </div>
            ))}
          </div>
        </AnimSlot>
      </section>

      <section id="how" className="hm-section" aria-labelledby="how-title">
        <Heading id="how-title" eyebrow={h.how.eyebrow} title={h.how.title} sub={h.how.subtitle} />
        <AnimSlot id="how.steps" className="hm-how">
          <HowEmbed steps={h.how.steps} />
          {/* Readable steps for screen readers and search engines; the animation above is decorative. */}
          <ol className="visually-hidden">
            {h.how.steps.map((s) => (
              <li key={s.t}>
                {s.t}. {s.d}
              </li>
            ))}
          </ol>
        </AnimSlot>
      </section>

      <section id="features" className="hm-section" aria-labelledby="features-title">
        <Heading id="features-title" eyebrow={f.eyebrow} title={f.title} sub={f.subtitle} />
        <AnimSlot id="features.cards" className="hm-cards">
          <Card icon="message-circle" title={f.inbox.title} text={f.inbox.text}>
            <div className="hm-list">
              {f.inbox.sample.map((c, i) => {
                const tone: Tone = i === 0 ? 'info' : i === 1 ? 'neutral' : 'warning';
                const av = [
                  ['var(--brand-50)', 'var(--brand-700)'],
                  ['var(--ink-50)', 'var(--ink-700)'],
                  ['var(--warning-bg)', 'var(--warning-fg)'],
                ][i]!;
                return (
                  <div key={c.name} className="hm-row">
                    <span className="hm-av" style={{ background: av[0], color: av[1] }}>
                      {c.name.replace('@', '')[0]?.toUpperCase()}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                        <strong>{c.name}</strong>
                        <span className="hm-time">{c.time}</span>
                      </div>
                      <div className="hm-preview">{c.text}</div>
                    </div>
                    <Badge tone={tone}>{c.badge}</Badge>
                  </div>
                );
              })}
            </div>
          </Card>
          <Card icon="package" title={f.catalog.title} text={f.catalog.text}>
            <div className="hm-list">
              {f.catalog.sample.map((p, i) => {
                const [sku, pct, color] = [
                  ['BAG-LN-SND', 20, 'var(--warning-fg)'],
                  ['CND-LAV-200', 90, 'var(--success-fg)'],
                  ['PLD-WL-01', 0, 'var(--danger-fg)'],
                ][i] as [string, number, string];
                return (
                  <div key={sku} className="hm-row hm-stock">
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                      <strong style={{ flex: 1 }}>{p.name}</strong>
                      <span className="hm-sku">{sku}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div className="hm-bar">
                        <div style={{ width: `${pct}%`, background: color }} />
                      </div>
                      <span className="hm-stock-label" style={{ color }}>
                        {p.label}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
          <Card icon="camera" title={f.photo.title} text={f.photo.text}>
            <div className="hm-list">
              <div className="hm-row">
                <span className="hm-photo" aria-hidden="true">
                  <Icon name="camera" size={22} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{f.photo.from}</strong>
                  <div className="hm-preview">{f.photo.question}</div>
                </div>
                <Badge tone="info">Instagram</Badge>
              </div>
              <div className="hm-qa hm-qa-photo">
                <div className="hm-q">{f.photo.assistant}</div>
                <div className="hm-a">{f.photo.answer}</div>
                <div className="hm-row hm-match">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{f.photo.match}</strong>
                    <div className="hm-sku">BAG-LN-SND</div>
                  </div>
                  <Badge tone="success">{f.photo.matchBadge}</Badge>
                </div>
              </div>
            </div>
            <CardNote icon="lock" text={f.photo.note} />
          </Card>
          <Card icon="store" title={f.storefront.title} text={f.storefront.text}>
            <div className="hm-store">
              <div className="hm-store-bar">
                <span>{f.storefront.url}</span>
                <Badge tone="success">{f.storefront.badge}</Badge>
              </div>
              <div className="hm-store-grid">
                {f.storefront.items.map((p, i) => (
                  <div key={p.name} className="hm-store-item">
                    <div aria-hidden="true" className="hm-store-thumb" style={{ background: STORE_THUMBS[i] }} />
                    <div className="hm-store-name">{p.name}</div>
                    <div className="hm-store-price">{p.price}</div>
                  </div>
                ))}
              </div>
              <div className="hm-store-links">
                <StoreLink icon="message-circle" label={f.storefront.chat} />
                <StoreLink icon="send" label="Telegram" />
                <StoreLink icon="instagram" label="Instagram" />
              </div>
            </div>
            <CardNote icon="package" text={f.storefront.note} />
          </Card>

          <div className="hm-card hm-rules">
            <div className="hm-rules-copy">
              <div className="hm-eyebrow">{f.rules.eyebrow}</div>
              <div className="hm-rules-title">{f.rules.title}</div>
              <p>{f.rules.text}</p>
              <div className="hm-checks">
                <div>
                  <span style={{ color: 'var(--success-fg)', display: 'flex' }}>
                    <Icon name="check" size={18} />
                  </span>
                  {f.rules.ok}
                </div>
                <div>
                  <span style={{ color: 'var(--warning-fg)', display: 'flex' }}>
                    <Icon name="circle-alert" size={18} />
                  </span>
                  {f.rules.missing}
                </div>
              </div>
            </div>
            <div className="hm-rules-grid">
              {f.rules.items.map((r) => (
                <div key={r.title} className="hm-rule">
                  <div className="hm-rule-head">
                    <strong>{r.title}</strong>
                    <Badge tone="success">{fmt(f.rules.version, { n: r.version })}</Badge>
                  </div>
                  <div className="hm-rule-text">{r.text}</div>
                </div>
              ))}
              <div className="hm-rule hm-rule-empty">
                <div className="hm-rule-head">
                  <strong>{f.rules.empty.title}</strong>
                  <Badge tone="warning">{f.rules.empty.badge}</Badge>
                </div>
                <div className="hm-rule-text">{f.rules.empty.text}</div>
              </div>
              <div className="hm-qa">
                <div className="hm-q">{f.rules.question}</div>
                <div className="hm-a">{f.rules.answer}</div>
              </div>
            </div>
          </div>

          <Card icon="truck" title={f.np.title} text={f.np.text}>
            <div className="hm-row hm-foot">
              <div style={{ flex: 1 }}>
                <div className="hm-label">{f.np.label}</div>
                <div className="hm-ttn">20450912345678</div>
              </div>
              <Badge tone="success">{f.np.badge}</Badge>
            </div>
          </Card>
          <Card icon="credit-card" title={f.mono.title} text={f.mono.text}>
            <div className="hm-row hm-foot">
              <div style={{ flex: 1 }}>
                <div className="hm-label">{f.mono.label}</div>
                <div className="hm-sum">1 280 ₴</div>
              </div>
              <Badge tone="info">{f.mono.badge}</Badge>
            </div>
          </Card>

          <div className="hm-card hm-analytics">
            <div className="hm-analytics-copy">
              <div className="hm-card-head">
                <IconTile icon="chart-no-axes-column" />
                <h3>{f.analytics.title}</h3>
              </div>
              <p>{f.analytics.text}</p>
              <div className="hm-usage">
                <UsageMeter label={f.analytics.usage} value={1240} max={2000} valueLabel={f.analytics.usageValue} />
                <div>{f.analytics.usageLeft}</div>
              </div>
            </div>
            <div className="hm-analytics-data">
              <div className="hm-funnel-head">
                <div>{f.analytics.funnelTitle}</div>
                <Badge tone="success">{f.analytics.funnelBadge}</Badge>
              </div>
              {f.analytics.funnel.map((row, i) => (
                <div key={row.label} className="hm-funnel-row">
                  <div className="hm-funnel-label">
                    <span>{row.label}</span>
                    <strong>{row.value}</strong>
                    <span className="hm-funnel-pct">{row.pct}%</span>
                  </div>
                  <div className="hm-funnel-track">
                    <div style={{ width: `${row.pct}%`, background: FUNNEL_COLORS[i] }} />
                  </div>
                </div>
              ))}
              <div className="hm-daily">
                <div className="hm-daily-head">
                  <span>{f.analytics.daily}</span>
                  <span>{f.analytics.dailyRange}</span>
                </div>
                <div className="hs-bars hm-bars" aria-hidden="true">
                  {DAILY_BARS.map((pct, i) => (
                    <i key={i} style={{ height: `${pct}%`, background: i === DAILY_BARS.length - 1 ? 'var(--brand-600)' : 'var(--brand-300)' }} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </AnimSlot>
      </section>

      <section id="control" className="hm-section" aria-labelledby="control-title">
        <div className="hm-control">
          <div>
            <div className="hm-eyebrow">{h.control.eyebrow}</div>
            <h2 id="control-title" className="hm-h2">
              {h.control.title} <span className="hm-muted">{h.control.titleMuted}</span>
            </h2>
            <p className="hm-control-text">{h.control.text}</p>
          </div>
          <ul className="hm-control-list">
            {h.control.items.map((text, i) => (
              <li key={text}>
                <IconTile icon={CONTROL_ICONS[i] ?? 'check'} />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="hm-section hm-last" aria-labelledby="cta-title">
        <AnimSlot id="cta.final" className="hm-cta">
          <CtaBg />
          <div className="hm-cta-card">
            <h2 id="cta-title" className="hm-h2">
              {h.cta.title} <span>{h.cta.text}</span>
            </h2>
            <div className="hm-actions" style={{ justifyContent: 'center', marginTop: 32 }}>
              <ButtonLink variant="primary" size="lg" arrow href={dashboard('register')}>
                {h.cta.primary}
              </ButtonLink>
              <ButtonLink variant="secondary" size="lg" href={dashboard('login')}>
                {h.cta.secondary}
              </ButtonLink>
            </div>
          </div>
        </AnimSlot>
      </section>
    </div>
  );
}

const CONTROL_ICONS: IconName[] = ['book-open', 'shield-check', 'hand', 'pause', 'gauge'];
const STORE_THUMBS = ['linear-gradient(135deg, var(--warning-bg), var(--brand-100))', 'linear-gradient(135deg, var(--brand-50), var(--brand-200))'];
const FUNNEL_COLORS = ['var(--brand-300)', 'var(--brand-500)', 'var(--brand-700)'];
const DAILY_BARS = [38, 52, 44, 61, 70, 48, 35, 58, 66, 74, 63, 81, 69, 90];

function Heading({ id, eyebrow, title, sub }: { id: string; eyebrow: string; title: string; sub: string }) {
  return (
    <>
      <div className="hm-eyebrow">{eyebrow}</div>
      <h2 id={id} className="hm-h2 hm-heading">
        {title} <span>{sub}</span>
      </h2>
    </>
  );
}

function Card({ icon, title, text, children }: { icon: IconName; title: string; text: string; children: ReactNode }) {
  return (
    <div className="hm-card">
      <div className="hm-card-head">
        <IconTile icon={icon} />
        <h3>{title}</h3>
      </div>
      <p>{text}</p>
      {children}
    </div>
  );
}

function CardNote({ icon, text }: { icon: IconName; text: string }) {
  return (
    <div className="hm-card-note">
      <span>
        <Icon name={icon} size={18} />
      </span>
      {text}
    </div>
  );
}

function StoreLink({ icon, label }: { icon: IconName; label: string }) {
  return (
    <span className="hm-store-link">
      <Icon name={icon} size={18} />
      {label}
    </span>
  );
}

function Logo({ src, alt, name }: { src: string; alt: string; name?: string }) {
  return (
    <div className="hm-item">
      <img className="hm-logo" src={src} alt={name ? '' : alt} height={36} />
      {name && <span className="hm-name">{name}</span>}
    </div>
  );
}
