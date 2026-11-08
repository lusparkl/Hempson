import { AnimSlot } from '../components/AnimSlot';
import { PageHero } from '../components/Layout';
import { fmt, usePage } from '../context';
import { PRICING, type PlanId } from '../site';
import { Faq } from '../components/Faq';
import { Badge, ButtonLink, Icon, IconTile } from '../../../../packages/ui/src/components';
import type { IconName } from '../../../../packages/ui/src/icons';

/** Plan highlighted as recommended. TODO(owner): confirm. */
const RECOMMENDED: PlanId = 'growth';
const INCLUDED_ICONS: IconName[] = ['message-circle', 'truck', 'chart-no-axes-column', 'package'];
const NOTE_ICONS: IconName[] = ['credit-card', 'circle-alert'];

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
                <span className={unlimited ? 'price price-text' : plan.priceUah === null ? 'price price-text tbd' : 'price'}>{price}</span>
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
        <div className="pricing-band">
          <div>
            <div className="hm-eyebrow">{p.included.eyebrow}</div>
            <h2>
              {p.included.title} <span className="hm-muted">{p.included.titleMuted}</span>
            </h2>
            <div className="pricing-notes">
              {p.notes.map((n, i) => (
                <div key={n}>
                  <span>
                    <Icon name={NOTE_ICONS[i] ?? 'check'} size={18} />
                  </span>
                  {n}
                </div>
              ))}
            </div>
          </div>
          <ul className="pricing-tiles">
            {p.included.items.map((item, i) => (
              <li key={item.title}>
                <IconTile icon={INCLUDED_ICONS[i] ?? 'check'} />
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>
      <Faq id="pricing-faq" title={p.faqTitle} items={p.faq} />
    </>
  );
}
