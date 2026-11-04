import { AnimSlot } from '../components/AnimSlot';
import { CompanyDetails, CtaBand, PageHero, Split } from '../components/Layout';
import { usePage } from '../context';
import { IconTile } from '../../../../packages/ui/src/components';
import type { IconName } from '../../../../packages/ui/src/icons';

const PRINCIPLE_ICONS: IconName[] = ['shield-check', 'sliders-horizontal', 'plug', 'wallet'];

export function About() {
  const { d } = usePage();
  const p = d.pages.about;
  return (
    <>
      <PageHero eyebrow={p.eyebrow} title={p.title} intro={p.intro} />
      <div className="mission-band">
        <Split title={p.mission.title}>
          <p className="mission-text">{p.mission.text}</p>
        </Split>
      </div>
      <Split title={p.story.title}>
        <div className="story">
          {p.story.paragraphs.map((t) => (
            <p key={t}>{t}</p>
          ))}
        </div>
      </Split>
      <section className="page-block" aria-labelledby="principles-title">
        <h2 id="principles-title">{p.principles.title}</h2>
        <AnimSlot id="about.principles" as="ul" className="card-grid">
          {p.principles.items.map((i, n) => (
            <li key={i.title} className="card">
              <IconTile icon={PRINCIPLE_ICONS[n] ?? 'sparkles'} />
              <h3>{i.title}</h3>
              <p>{i.text}</p>
            </li>
          ))}
        </AnimSlot>
      </section>
      <section className="page-block" aria-labelledby="team-title">
        <h2 id="team-title">{p.team.title}</h2>
        {/* TODO(design): team grid with photos once the owner supplies names and portraits */}
        <p className="muted">{p.team.text}</p>
      </section>
      <Split title={p.company.title} className="page-last">
        <CompanyDetails />
      </Split>
      <CtaBand />
    </>
  );
}
