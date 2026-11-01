import { AnimSlot } from '../components/AnimSlot';
import { usePage } from '../context';

export function Home() {
  const { d, href, dashboard } = usePage();
  const h = d.pages.home;
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <AnimSlot id="hero.intro" className="hero-copy">
          <h1 id="hero-title">{h.hero.title}</h1>
          <p className="lead">{h.hero.subtitle}</p>
          <div className="actions">
            <a className="btn btn-primary" href={dashboard('register')}>
              {h.hero.primaryCta}
            </a>
            <a className="btn btn-secondary" href="#how">
              {h.hero.secondaryCta}
            </a>
          </div>
        </AnimSlot>
        <AnimSlot id="hero.chat-demo" className="hero-visual" />
      </section>

      <section id="channels" aria-labelledby="channels-title">
        <h2 id="channels-title">{h.channels.title}</h2>
        <AnimSlot id="channels.icons" as="ul" className="channel-list">
          {h.channels.items.map((c) => (
            <li key={c.name}>
              <h3>{c.name}</h3>
              <p>{c.text}</p>
            </li>
          ))}
        </AnimSlot>
      </section>

      <section id="how" aria-labelledby="how-title">
        <h2 id="how-title">{h.how.title}</h2>
        <AnimSlot id="how.steps" as="ol" className="steps">
          {h.how.steps.map((s) => (
            <li key={s.title}>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </AnimSlot>
      </section>

      <section id="features" aria-labelledby="features-title">
        <h2 id="features-title">{h.features.title}</h2>
        <AnimSlot id="features.cards" as="ul" className="card-grid">
          {h.features.items.map((f) => (
            <li key={f.title} className="card">
              {/* TODO(design): icon per card */}
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </li>
          ))}
        </AnimSlot>
        <a href={href('features')}>{h.features.more}</a>
      </section>

      <section id="trust" aria-labelledby="trust-title">
        <h2 id="trust-title">{h.trust.title}</h2>
        <p>{h.trust.text}</p>
        <AnimSlot id="trust.guard" className="trust-visual" />
        <ul className="checklist">
          {h.trust.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </section>

      <section id="pricing" aria-labelledby="pricing-title">
        <h2 id="pricing-title">{h.pricing.title}</h2>
        <p>{h.pricing.text}</p>
        <a className="btn btn-secondary" href={href('pricing')}>
          {h.pricing.cta}
        </a>
      </section>

      <Faq id="faq" title={h.faq.title} items={h.faq.items} />

      <AnimSlot id="cta.final" as="section" className="cta-band">
        <h2>{h.cta.title}</h2>
        <p>{h.cta.text}</p>
        <a className="btn btn-primary" href={dashboard('register')}>
          {h.cta.button}
        </a>
      </AnimSlot>
    </>
  );
}

/** FAQ list on native <details>, so it opens without JS. */
export function Faq({ id, title, items }: { id: string; title: string; items: ReadonlyArray<{ q: string; a: string }> }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      <AnimSlot id="faq.accordion" className="faq">
        {items.map((i) => (
          <details key={i.q}>
            <summary>{i.q}</summary>
            <p>{i.a}</p>
          </details>
        ))}
      </AnimSlot>
    </section>
  );
}
