import { CompanyDetails, ContactList } from '../components/Layout';
import { fmt, usePage } from '../context';
import type { LegalRouteId } from '../routes';
import { SITE } from '../site';

/** Shared layout of every legal document: title, date, draft notice, numbered sections, company and contacts. */
export function Legal({ doc }: { doc: LegalRouteId }) {
  const { d, locale } = usePage();
  const p = d.pages[doc];
  const date = new Intl.DateTimeFormat(locale === 'uk' ? 'uk-UA' : 'ru-UA', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(SITE.legalUpdatedAt));
  return (
    <article className="legal">
      <header>
        <h1>{p.title}</h1>
        <p className="note">
          <time dateTime={SITE.legalUpdatedAt}>{fmt(d.common.updated, { date })}</time>
        </p>
        {!SITE.legalReviewed && (
          <p className="draft-notice" role="note">
            {d.common.draftNotice}
          </p>
        )}
        <p className="lead">{p.intro}</p>
      </header>
      {/* Table of contents for long documents. */}
      <nav aria-label={p.title} className="toc">
        <ol>
          {p.sections.map((s, i) => (
            <li key={s.title}>
              <a href={`#s${i + 1}`}>{s.title}</a>
            </li>
          ))}
        </ol>
      </nav>
      {p.sections.map((s, i) => (
        <section key={s.title} id={`s${i + 1}`}>
          <h2>
            {i + 1}. {s.title}
          </h2>
          {s.paragraphs.map((t) => (
            <p key={t}>{t}</p>
          ))}
        </section>
      ))}
      <footer>
        <CompanyDetails />
        <ContactList />
      </footer>
    </article>
  );
}
