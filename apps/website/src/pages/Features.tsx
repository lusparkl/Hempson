import { AnimSlot } from '../components/AnimSlot';
import { CtaBand, PageHero } from '../components/Layout';
import { usePage } from '../context';
import { Badge, IconTile } from '../../../../packages/ui/src/components';
import type { IconName } from '../../../../packages/ui/src/icons';

const ICON: Record<string, IconName> = {
  channels: 'message-circle',
  catalog: 'book-open',
  orders: 'shopping-bag',
  payments: 'credit-card',
  delivery: 'truck',
  control: 'users',
  analytics: 'chart-no-axes-column',
  photo: 'camera',
  storefront: 'store',
};

export function Features() {
  const { d } = usePage();
  const p = d.pages.features;
  return (
    <>
      <PageHero eyebrow={p.eyebrow} title={p.title} intro={p.intro} />
      <div className="features-list">
        {p.sections.map((s, i) => (
          <AnimSlot key={s.id} id="features.section" as="section" className={i % 2 ? 'feature reverse' : 'feature'}>
            <div id={s.id} className="feature-copy">
              <div className="feature-icon">
                <IconTile icon={ICON[s.id] ?? 'sparkles'} />
                {s.soon && <Badge>{d.common.soon}</Badge>}
              </div>
              <h2>{s.title}</h2>
              <p>{s.text}</p>
              {s.points.length > 0 && (
                <ul className="dots">
                  {s.points.map((pt) => (
                    <li key={pt}>{pt}</li>
                  ))}
                </ul>
              )}
            </div>
            {/* TODO(design): product screenshot for this section */}
            <div className="feature-visual placeholder" aria-hidden="true" data-placeholder={s.id} />
          </AnimSlot>
        ))}
      </div>
      <CtaBand />
    </>
  );
}
