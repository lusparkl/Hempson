import { useEffect, useState, type ReactNode } from 'react';
import { AnimSlot } from './AnimSlot';
import { usePage, fmt } from '../context';
import { LOCALES, LOCALE_LABEL, localePath } from '../i18n';
import { ROUTES, pathOf } from '../routes';
import { SITE } from '../site';

export function Layout({ children }: { children: ReactNode }) {
  const { d } = usePage();
  return (
    <>
      <a className="skip-link" href="#main">
        {d.common.skipToContent}
      </a>
      <Header />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <Footer />
    </>
  );
}

function Header() {
  const { d, href, dashboard } = usePage();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <AnimSlot id="header.scroll" as="div" className="site-header">
      <header data-scrolled={scrolled || undefined}>
        <a className="logo" href={href('home')} aria-label={SITE.name}>
          {/* TODO(design): logo mark */}
          {SITE.name}
        </a>
        <button type="button" className="menu-toggle" aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen(!open)}>
          {open ? d.common.menuClose : d.common.menuOpen}
        </button>
        <AnimSlot id="header.mobile-menu" as="div" className="site-nav-wrap">
          <nav id="site-nav" data-open={open || undefined}>
            <ul>
              {ROUTES.filter((r) => r.nav === 'main').map((r) => (
                <li key={r.id}>
                  <NavLink id={r.id} label={d.common.nav[r.id]} />
                </li>
              ))}
            </ul>
            <LanguageSwitcher />
            <a className="btn btn-secondary" href={dashboard('login')}>
              {d.common.login}
            </a>
            <a className="btn btn-primary" href={dashboard('register')}>
              {d.common.start}
            </a>
          </nav>
        </AnimSlot>
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

/** Links to the same page in every locale. Plain links, so it works without JS and search engines follow it. */
export function LanguageSwitcher() {
  const { d, locale, route } = usePage();
  const path = route === 'notFound' ? '/' : pathOf(route);
  return (
    <AnimSlot id="lang.switch" as="div" className="lang-switch">
      <span className="visually-hidden">{d.common.language}</span>
      <ul>
        {LOCALES.map((l) => (
          <li key={l}>
            <a href={localePath(l, path)} hrefLang={l} lang={l} aria-current={l === locale ? 'true' : undefined}>
              {LOCALE_LABEL[l]}
            </a>
          </li>
        ))}
      </ul>
    </AnimSlot>
  );
}

function Footer() {
  const { d, href } = usePage();
  const f = d.common.footer;
  return (
    <footer className="site-footer">
      <div className="footer-brand">
        <a className="logo" href={href('home')}>
          {SITE.name}
        </a>
        <p>{f.tagline}</p>
      </div>
      <nav aria-label={f.product}>
        <h2>{f.product}</h2>
        <ul>
          <li>
            <a href={href('features')}>{d.common.nav.features}</a>
          </li>
          <li>
            <a href={href('pricing')}>{d.common.nav.pricing}</a>
          </li>
          <li>
            <a href={href('security')}>{d.common.nav.security}</a>
          </li>
        </ul>
      </nav>
      <nav aria-label={f.company}>
        <h2>{f.company}</h2>
        <ul>
          <li>
            <a href={href('about')}>{d.common.nav.about}</a>
          </li>
          <li>
            <a href={href('contact')}>{d.common.nav.contact}</a>
          </li>
        </ul>
      </nav>
      <nav aria-label={f.legal}>
        <h2>{f.legal}</h2>
        <ul>
          {ROUTES.filter((r) => r.nav === 'legal').map((r) => (
            <li key={r.id}>
              <a href={href(r.id)}>{d.pages[r.id].title}</a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="footer-contacts">
        <h2>{f.contacts}</h2>
        <ContactList />
      </div>
      <div className="footer-bottom">
        <CompanyDetails compact />
        <p>{fmt(f.rights, { year: new Date().getFullYear() })}</p>
        <LanguageSwitcher />
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
      <dt>{L.email}</dt>
      <dd>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : d.common.tbd}</dd>
      <dt>{L.telegram}</dt>
      <dd>{c.telegram ? <a href={`https://t.me/${c.telegram}`}>@{c.telegram}</a> : d.common.tbd}</dd>
      {c.phone && (
        <>
          <dt>{L.phone}</dt>
          <dd>
            <a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}>{c.phone}</a>
          </dd>
        </>
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

/** Inner-page title block. */
export function PageHero({ title, intro, children }: { title: string; intro?: string; children?: ReactNode }) {
  return (
    <AnimSlot id="page.hero" as="section" className="page-hero">
      <h1>{title}</h1>
      {intro && <p className="lead">{intro}</p>}
      {children}
    </AnimSlot>
  );
}
