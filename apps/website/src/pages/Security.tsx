import { PageHero } from '../components/Layout';
import { usePage } from '../context';
import { SITE } from '../site';
import { IconTile } from '../../../../packages/ui/src/components';
import type { IconName } from '../../../../packages/ui/src/icons';

const ICONS: IconName[] = ['lock', 'globe', 'key-round', 'credit-card', 'layers', 'trash-2'];

export function Security() {
  const { d, href } = usePage();
  const p = d.pages.security;
  const email = SITE.contacts.security ?? SITE.contacts.email;
  return (
    <>
      <PageHero eyebrow={p.eyebrow} title={p.title} intro={p.intro} />
      <ul className="card-grid card-grid-wide">
        {p.sections.map((s, i) => (
          <li key={s.title} className="card">
            <IconTile icon={ICONS[i] ?? 'shield-check'} />
            <h2>{s.title}</h2>
            <p>{s.text}</p>
            {i === p.sections.length - 1 && (
              <a className="card-link" href={href('dataDeletion')}>
                {p.deletionLink}
              </a>
            )}
          </li>
        ))}
      </ul>
      <section className="page-block page-last">
        <p className="report-box">
          {p.report} {email ? <a href={`mailto:${email}`}>{email}</a> : d.common.tbd}
        </p>
      </section>
    </>
  );
}
