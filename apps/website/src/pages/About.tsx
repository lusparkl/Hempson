import { AnimSlot } from '../components/AnimSlot';
import { CompanyDetails, PageHero } from '../components/Layout';
import { usePage } from '../context';

export function About() {
  const { d } = usePage();
  const p = d.pages.about;
  return (
    <>
      <PageHero title={p.title} intro={p.intro} />
      <section aria-labelledby="mission-title">
        <h2 id="mission-title">{p.mission.title}</h2>
        <p>{p.mission.text}</p>
      </section>
      <section aria-labelledby="story-title">
        <h2 id="story-title">{p.story.title}</h2>
        {p.story.paragraphs.map((t) => (
          <p key={t}>{t}</p>
        ))}
      </section>
      <section aria-labelledby="principles-title">
        <h2 id="principles-title">{p.principles.title}</h2>
        <AnimSlot id="about.principles" as="ul" className="card-grid">
          {p.principles.items.map((i) => (
            <li key={i.title} className="card">
              <h3>{i.title}</h3>
              <p>{i.text}</p>
            </li>
          ))}
        </AnimSlot>
      </section>
      <section aria-labelledby="team-title">
        <h2 id="team-title">{p.team.title}</h2>
        {/* TODO(design): team grid with photos */}
        <p>{p.team.text}</p>
      </section>
      <section aria-labelledby="company-title">
        <h2 id="company-title">{p.company.title}</h2>
        <CompanyDetails />
      </section>
    </>
  );
}
