import { CompanyDetails, PageHero, Split } from '../components/Layout';
import { usePage } from '../context';
import { SITE } from '../site';
import { IconTile } from '../../../../packages/ui/src/components';
import type { IconName } from '../../../../packages/ui/src/icons';

/** No contact form on purpose: it would need a public endpoint and spam protection. Links only. */
export function Contact() {
  const { d } = usePage();
  const p = d.pages.contact;
  const c = SITE.contacts;
  const L = d.common.contactLabels;
  const security = c.security ?? c.email;
  const cards: Array<{ icon: IconName; label: string; value: string | null; href: string | null }> = [
    { icon: 'mail', label: L.email, value: c.email, href: c.email && `mailto:${c.email}` },
    { icon: 'send', label: L.telegram, value: c.telegram && `@${c.telegram}`, href: c.telegram && `https://t.me/${c.telegram}` },
    ...(c.phone ? [{ icon: 'phone' as const, label: L.phone, value: c.phone, href: `tel:${c.phone.replace(/[^\d+]/g, '')}` }] : []),
    { icon: 'shield', label: L.security, value: security, href: security && `mailto:${security}` },
  ];
  return (
    <>
      <PageHero eyebrow={p.eyebrow} title={p.title} intro={p.intro} />
      <section className="page-block" aria-label={p.write}>
        <ul className="card-grid">
          {cards.map((k) => (
            <li key={k.label}>
              {k.href ? (
                <a className="card contact-card" href={k.href}>
                  <ContactCard {...k} />
                </a>
              ) : (
                <div className="card contact-card">
                  <ContactCard {...k} />
                </div>
              )}
            </li>
          ))}
        </ul>
        <p className="muted contact-hours">{p.hours}</p>
      </section>
      <Split title={p.company} className="page-last">
        <CompanyDetails />
      </Split>
    </>
  );
}

function ContactCard({ icon, label, value }: { icon: IconName; label: string; value: string | null }) {
  const { d } = usePage();
  return (
    <>
      <IconTile icon={icon} />
      <span className="contact-label">{label}</span>
      <span className="contact-value">{value ?? d.common.tbd}</span>
    </>
  );
}
