import { usePage } from '../context';
import { ButtonLink } from '../../../../packages/ui/src/components';

export function NotFound() {
  const { d, href } = usePage();
  const p = d.pages.notFound;
  return (
    <section className="not-found">
      <div className="not-found-code">{p.code}</div>
      <h1>{p.title}</h1>
      <p>{p.text}</p>
      <ButtonLink variant="primary" size="lg" arrow href={href('home')}>
        {p.home}
      </ButtonLink>
    </section>
  );
}
