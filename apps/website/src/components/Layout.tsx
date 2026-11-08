import { useEffect, useState, type ReactNode } from 'react';
import { AnimSlot } from './AnimSlot';
import { fmt, usePage } from '../context';
import { ButtonLink, LogoMark } from '../../../../packages/ui/src/components';
import { ROUTES } from '../routes';
import { SITE } from '../site';

export function Layout({ children }: { children: ReactNode }) {
  const { d, route } = usePage();
  return (
    <>
      <a className="skip-link" href="#main">
        {d.common.skipToContent}
      </a>
      <Header />
      <main id="main" tabIndex={-1} data-route={route}>
        {children}
      </main>
      <Footer />
    </>
  );
}

function Header() {
  const { d, href, dashboard, route } = usePage();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  // Design: the home page links to its own sections; inner pages ("Hepson Site") link to the pages.
  const n = d.pages.home.nav;
  return (
    <AnimSlot id="header.scroll" as="div" className="site-header">
      <header data-scrolled={scrolled || undefined}>
        <a className="hs-wordmark logo" href={href('home')} aria-label={`${SITE.name} — на головну`}>
          <LogoMark size={30} />
          <span>hepson</span>
        </a>
        {route === 'home' ? (
          <nav id="site-nav" aria-label={SITE.name}>
            <a href="#how">{n.how}</a>
            <a href="#features">{n.features}</a>
            <a href="#control">{n.control}</a>
            <a href={href('demo')}>{d.common.nav.demo}</a>
          </nav>
        ) : (
          <nav id="site-nav" className="site-nav-pages" aria-label={SITE.name}>
            {ROUTES.filter((r) => r.nav === 'main').map((r) => (
              <NavLink key={r.id} id={r.id} label={d.common.nav[r.id]} />
            ))}
          </nav>
        )}
        <div className="header-actions">
          <ButtonLink variant="secondary" size="sm" href={dashboard('login')}>
            {d.common.login}
          </ButtonLink>
          <ButtonLink variant="primary" size="sm" arrow href={dashboard('register')}>
            {d.common.start}
          </ButtonLink>
        </div>
      </header>
    </AnimSlot>
  );
}

function NavLink({ id, label }: { id: (typeof ROUTES)[number]['id']; label: string }) {
  const { href, route } = usePage();
  return (
    <a href={href(id)} aria-current={route === id ? 'page' : undefined}>
      {label}
    </a>
  );
}

/** Shared footer ("Hepson Footer" design): brand, link columns, contacts, then company details and copyright. */
function Footer() {
  const { d, href, dashboard } = usePage();
  const f = d.common.footer;
  const legal = ROUTES.filter((r) => r.nav === 'legal');
  return (
    <footer className="site-footer">
      <div className="footer-top">
        <div className="footer-brand">
          <a className="hs-wordmark logo" href={href('home')} aria-label={`${SITE.name} — на головну`}>
            <LogoMark size={30} />
            <span>hepson</span>
          </a>
          <p>{f.tagline}</p>
        </div>
        <div className="footer-cols">
          <nav aria-label={f.product}>
            <h2>{f.product}</h2>
            <ul>
              {(['features', 'pricing', 'security'] as const).map((id) => (
                <li key={id}>
                  <NavLink id={id} label={d.common.nav[id]} />
                </li>
              ))}
              <li>
                <a href={dashboard('login')}>{f.dashboard}</a>
              </li>
            </ul>
          </nav>
          <nav aria-label={f.company}>
            <h2>{f.company}</h2>
            <ul>
              {(['about', 'contact'] as const).map((id) => (
                <li key={id}>
                  <NavLink id={id} label={d.common.nav[id]} />
                </li>
              ))}
            </ul>
          </nav>
          <nav aria-label={f.legal}>
            <h2>{f.legal}</h2>
            <ul>
              {legal.map((r) => (
                <li key={r.id}>
                  <NavLink id={r.id} label={r.id === 'refunds' ? f.refunds : d.pages[r.id].title} />
                </li>
              ))}
            </ul>
          </nav>
          <div>
            <h2>{f.contacts}</h2>
            <ContactList />
          </div>
        </div>
      </div>
      <div className="footer-bottom">
        <CompanyDetails compact />
        <p>{fmt(f.rights, { year: new Date().getFullYear() })}</p>
      </div>
    </footer>
  );
}

/** Email, Telegram, phone from `SITE.contacts`; missing ones show the "to be announced" text. */
export function ContactList() {
  const { d } = usePage();
  const c = SITE.contacts;
  const L = d.common.contactLabels;
  return (
    <dl className="contact-list">
      <div>
        <dt>{L.email}</dt>
        <dd>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : d.common.tbd}</dd>
      </div>
      <div>
        <dt>{L.telegram}</dt>
        <dd>{c.telegram ? <a href={`https://t.me/${c.telegram}`}>@{c.telegram}</a> : d.common.tbd}</dd>
      </div>
      {c.phone && (
        <div>
          <dt>{L.phone}</dt>
          <dd>
            <a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}>{c.phone}</a>
          </dd>
        </div>
      )}
    </dl>
  );
}

/** Legal entity block required on legal pages; until the FOP exists it says so instead of showing blanks. */
export function CompanyDetails({ compact = false }: { compact?: boolean }) {
  const { d } = usePage();
  const e = SITE.legalEntity;
  if (!e.name) return <p className="company-details">{d.common.footer.entityPending}</p>;
  if (compact) return <p className="company-details">{[e.name, e.taxId, e.address].filter(Boolean).join(' · ')}</p>;
  const L = d.common.entityLabels;
  return (
    <dl className="company-details">
      <dt>{L.name}</dt>
      <dd>{e.name}</dd>
      {e.taxId && (
        <>
          <dt>{L.taxId}</dt>
          <dd>{e.taxId}</dd>
        </>
      )}
      {e.address && (
        <>
          <dt>{L.address}</dt>
          <dd>{e.address}</dd>
        </>
      )}
    </dl>
  );
}

/** Inner-page title block: eyebrow, title, intro. */
export function PageHero({ eyebrow, title, intro, children }: { eyebrow?: string; title: string; intro?: string; children?: ReactNode }) {
  return (
    <AnimSlot id="page.hero" as="section" className="page-hero">
      {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
      <h1>{title}</h1>
      {intro && <p className="lead">{intro}</p>}
      {children}
    </AnimSlot>
  );
}

/** Label on the left, content on the right (mission, story, company details). */
export function Split({ title, className = '', children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <section className={`page-split ${className}`}>
      <h2 className="page-split-title">{title}</h2>
      {children}
    </section>
  );
}

/** Shared closing band ("Hepson CTA" design). */
export function CtaBand() {
  const { d, dashboard } = usePage();
  const c = d.common.cta;
  return (
    <section className="cta-band">
      <h2>{c.title}</h2>
      <p>{c.text}</p>
      <ButtonLink variant="primary" size="lg" arrow href={dashboard('register')}>
        {c.button}
      </ButtonLink>
    </section>
  );
}
