import { CompanyDetails, ContactList } from '../components/Layout';
import { fmt, usePage } from '../context';
import { ROUTES, type LegalRouteId } from '../routes';
import { SITE } from '../site';
import { ButtonLink } from '../../../../packages/ui/src/components';

/**
 * Shared layout of every legal document ("Hepson Site" design): breadcrumb, sticky side table of
 * contents and document list, then title, date, draft notice, numbered sections, company and contacts.
 */
export function Legal({ doc }: { doc: LegalRouteId }) {
  const { d, href } = usePage();
  const p = d.pages[doc];
  const L = d.common.legal;
  const date = new Intl.DateTimeFormat('uk-UA', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(SITE.legalUpdatedAt)).replace(/ р\.$/, '');
  return (
    <div className="legal-page">
      <nav className="breadcrumb" aria-label={L.breadcrumb}>
        <a href={href('contact')}>{L.breadcrumb}</a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{p.title}</span>
      </nav>
      <div className="legal-split">
        <aside className="legal-side">
          <nav aria-label={L.toc}>
            <div className="legal-side-title">{L.toc}</div>
            <ol>
              {p.sections.map((s, i) => (
                <li key={s.title}>
                  <a href={`#s${i + 1}`}>
                    <span>{i + 1}</span>
                    {s.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          <nav aria-label={L.all}>
            <div className="legal-side-title">{L.all}</div>
            <ul>
              {ROUTES.filter((r) => r.nav === 'legal').map((r) => (
                <li key={r.id}>
                  <a href={href(r.id)} aria-current={r.id === doc ? 'page' : undefined}>
                    {d.pages[r.id].title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
        <article className="legal">
          <h1>{p.title}</h1>
          <p className="legal-date">
            <time dateTime={SITE.legalUpdatedAt}>{fmt(d.common.updated, { date })}</time>
          </p>
          {!SITE.legalReviewed && (
            <p className="draft-notice" role="note">
              {d.common.draftNotice}
            </p>
          )}
          <p className="lead">{p.intro}</p>
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
          {doc === 'cookies' && <StorageTable />}
          {doc === 'dataDeletion' && <DeletionRequest />}
          <footer className="legal-footer">
            <div>
              <div className="legal-side-title">{d.pages.about.company.title}</div>
              <CompanyDetails />
            </div>
            <div>
              <div className="legal-side-title">{d.common.footer.contacts}</div>
              <ContactList />
            </div>
          </footer>
        </article>
      </div>
    </div>
  );
}

/** What the site, dashboard and widget keep in the browser (see the cookies text). */
function StorageTable() {
  const { d } = usePage();
  const t = d.common.legal.storage;
  return (
    <div className="legal-box">
      <div className="legal-box-title">{t.title}</div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t.head.name}</th>
              <th>{t.head.where}</th>
              <th>{t.head.why}</th>
              <th>{t.head.ttl}</th>
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r) => (
              <tr key={r.name}>
                <td>
                  <code>{r.name}</code>
                </td>
                <td>{r.where}</td>
                <td>{r.why}</td>
                <td>{r.ttl}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Deletion request. The design shows a form; there is no public endpoint for it yet, so the button
 * opens a pre-filled email instead of pretending to submit.
 */
function DeletionRequest() {
  const { d } = usePage();
  const r = d.common.legal.deletionRequest;
  const email = SITE.contacts.email;
  return (
    <div className="legal-box legal-request">
      <div>
        <div className="legal-request-title">{r.title}</div>
        <p>{r.text}</p>
      </div>
      <div>
        {email ? (
          <ButtonLink variant="primary" size="md" href={`mailto:${email}?subject=${encodeURIComponent(r.subject)}`}>
            {r.send}
          </ButtonLink>
        ) : (
          <p>{d.common.tbd}</p>
        )}
      </div>
    </div>
  );
}
