import { AnimSlot } from '../components/AnimSlot';
import { PageHero } from '../components/Layout';
import { usePage } from '../context';

export function Features() {
  const { d, dashboard } = usePage();
  const p = d.pages.features;
  return (
    <>
      <PageHero title={p.title} intro={p.intro} />
      {p.sections.map((s, i) => (
        <AnimSlot key={s.id} id="features.section" as="section" className={i % 2 ? 'feature reverse' : 'feature'}>
          <div id={s.id} className="feature-copy">
            <h2>
              {s.title}
              {s.soon && <span className="badge">{d.common.soon}</span>}
            </h2>
            <p>{s.text}</p>
            {s.points.length > 0 && (
              <ul className="checklist">
                {s.points.map((pt) => (
                  <li key={pt}>{pt}</li>
                ))}
              </ul>
            )}
          </div>
          {/* TODO(design): illustration or product screenshot for this section */}
          <div className="feature-visual" aria-hidden="true" data-placeholder={s.id} />
        </AnimSlot>
      ))}
      <section className="cta-band">
        <a className="btn btn-primary" href={dashboard('register')}>
          {d.common.start}
        </a>
      </section>
    </>
  );
}
