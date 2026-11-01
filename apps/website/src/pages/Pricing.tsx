import { AnimSlot } from '../components/AnimSlot';
import { PageHero } from '../components/Layout';
import { fmt, usePage } from '../context';
import { PRICING, type PlanId } from '../site';
import { Faq } from './Home';

/** Plan highlighted as recommended. TODO(owner): confirm. */
const RECOMMENDED: PlanId = 'growth';

export function Pricing() {
  const { d, locale, dashboard } = usePage();
  const p = d.pages.pricing;
  const num = new Intl.NumberFormat(locale === 'uk' ? 'uk-UA' : 'ru-UA');
  return (
    <>
      <PageHero title={p.title} intro={p.intro} />
      <AnimSlot id="pricing.cards" as="ul" className="plans">
        {PRICING.map((plan) => (
          <li key={plan.id} className="plan" data-recommended={plan.id === RECOMMENDED || undefined}>
            {plan.id === RECOMMENDED && <span className="badge">{p.recommended}</span>}
            <h2>{p.plans[plan.id].name}</h2>
            <p className="price">{plan.priceUah === 0 ? p.free : plan.priceUah === null ? d.common.tbd : `${num.format(plan.priceUah)} ${p.perMonth}`}</p>
            <p className="replies">{plan.replies === null ? p.unlimitedReplies : fmt(p.replies, { n: num.format(plan.replies) })}</p>
            <p>{p.plans[plan.id].note}</p>
            <a className="btn btn-primary" href={dashboard('register')}>
              {p.choose}
            </a>
          </li>
        ))}
      </AnimSlot>
      <section aria-labelledby="included-title">
        <h2 id="included-title">{p.included.title}</h2>
        <ul className="checklist">
          {p.included.items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
        {p.notes.map((n) => (
          <p key={n} className="note">
            {n}
          </p>
        ))}
      </section>
      <Faq id="pricing-faq" title={d.pages.home.faq.title} items={p.faq} />
    </>
  );
}
