import { AnimSlot } from './AnimSlot';

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
