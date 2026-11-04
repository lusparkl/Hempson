import { AnimSlot } from '../components/AnimSlot';
import { PageHero } from '../components/Layout';
import { fmt, usePage } from '../context';
import { PRICING, type PlanId } from '../site';
import { Faq } from '../components/Faq';
import { Badge, ButtonLink } from '../../../../packages/ui/src/components';

/** Plan highlighted as recommended. TODO(owner): confirm. */
const RECOMMENDED: PlanId = 'growth';

export function Pricing() {
  const { d, href, dashboard } = usePage();
  const p = d.pages.pricing;
  const num = new Intl.NumberFormat('uk-UA');
  return (
    <>
      <PageHero eyebrow={p.eyebrow} title={p.title} intro={p.intro} />
      <AnimSlot id="pricing.cards" as="ul" className="plans">
        {PRICING.map((plan) => {
          const rec = plan.id === RECOMMENDED;
          const unlimited = plan.replies === null;
          // Prices not decided yet stay "to be announced" (SITE.PRICING), never invented.
          const price = unlimited ? p.custom : plan.priceUah === null ? d.common.tbd : num.format(plan.priceUah);
          const unit = unlimited || plan.priceUah === null ? '' : plan.priceUah === 0 ? p.currency : p.perMonth;
          return (
            <li key={plan.id} className="plan" data-recommended={rec || undefined}>
              <div className="plan-head">
                <h2>{p.plans[plan.id].name}</h2>
                {rec && <Badge tone="brand">{p.recommended}</Badge>}
              </div>
              <div className="plan-price">
                <span className={plan.priceUah === null ? 'price tbd' : 'price'}>{price}</span>
                {unit && <span className="unit">{unit}</span>}
              </div>
              <div className="plan-replies">{unlimited ? p.unlimitedReplies : fmt(p.replies, { n: num.format(plan.replies!) })}</div>
              <p className="plan-note">{p.plans[plan.id].note}</p>
              <ButtonLink variant={rec ? 'primary' : 'secondary'} size="md" href={unlimited ? href('contact') : dashboard('register')}>
                {plan.priceUah === 0 ? p.startFree : unlimited ? p.contactUs : p.choose}
              </ButtonLink>
            </li>
          );
        })}
      </AnimSlot>
      <section className="pricing-included">
        <div>
          <h2>{p.included.title}</h2>
          <ul className="dots">
            {p.included.items.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
        <div className="pricing-notes">
          {p.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      </section>
      <Faq id="pricing-faq" title={p.faqTitle} items={p.faq} />
    </>
  );
}
