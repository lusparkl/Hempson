import { useEffect, useState, type ReactNode } from 'react';
import { AnimSlot } from './AnimSlot';
import { usePage } from '../context';
import { ButtonLink, LogoMark } from '../../../../packages/ui/src/components';
import { LOCALES, LOCALE_LABEL, localePath } from '../i18n';
import { ROUTES, pathOf } from '../routes';
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
  // Design: the home sections as anchors (plain `#…` on the home page, `/#…` elsewhere).
  const n = d.pages.home.nav;
  const anchor = (id: string) => (route === 'home' ? `#${id}` : href('home', id));
  return (
    <AnimSlot id="header.scroll" as="div" className="site-header">
      <header data-scrolled={scrolled || undefined}>
        <a className="hs-wordmark logo" href={href('home')} aria-label={SITE.name}>
          <LogoMark size={30} />
          <span>hepson</span>
        </a>
        <nav id="site-nav" aria-label={SITE.name}>
          <a href={anchor('how')}>{n.how}</a>
          <a href={anchor('features')}>{n.features}</a>
          <a href={anchor('control')}>{n.control}</a>
        </nav>
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
      <div className="footer-main">
        <a className="hs-wordmark logo" href={href('home')} aria-label={SITE.name}>
          <LogoMark size={24} />
          <span>hepson</span>
        </a>
        <span>{f.tagline}</span>
        <span className="footer-copy">© {new Date().getFullYear()} Hepson</span>
      </div>
      <div className="footer-links">
        <nav aria-label={f.product}>
          {ROUTES.filter((r) => r.nav === 'main').map((r) => (
            <NavLink key={r.id} id={r.id} label={d.common.nav[r.id]} />
          ))}
        </nav>
        <nav aria-label={f.legal}>
          {ROUTES.filter((r) => r.nav === 'legal').map((r) => (
            <a key={r.id} href={href(r.id)}>
              {d.pages[r.id].title}
            </a>
          ))}
        </nav>
        <ContactList />
        <CompanyDetails compact />
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
