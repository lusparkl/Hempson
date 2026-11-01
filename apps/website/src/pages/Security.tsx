import { AnimSlot } from '../components/AnimSlot';
import { PageHero } from '../components/Layout';
import { fmt, usePage } from '../context';
import { SITE } from '../site';

export function Security() {
  const { d, href } = usePage();
  const p = d.pages.security;
  return (
    <>
      <PageHero title={p.title} intro={p.intro} />
      <AnimSlot id="security.flow" className="security-visual" />
      {p.sections.map((s, i) => (
        <section key={s.title} aria-labelledby={`security-${i}`}>
          <h2 id={`security-${i}`}>{s.title}</h2>
          <p>{s.text}</p>
          {i === p.sections.length - 1 && <a href={href('dataDeletion')}>{d.pages.dataDeletion.title}</a>}
        </section>
      ))}
      <p className="note">{fmt(p.report, { email: SITE.contacts.email ?? d.common.tbd })}</p>
    </>
  );
}
