import { AnimSlot } from '../components/AnimSlot';
import { usePage } from '../context';

export function NotFound() {
  const { d, href } = usePage();
  const p = d.pages.notFound;
  return (
    <section className="not-found">
      <AnimSlot id="notfound.illustration" className="not-found-visual" />
      <h1>{p.title}</h1>
      <p>{p.text}</p>
      <a className="btn btn-primary" href={href('home')}>
        {p.home}
      </a>
    </section>
  );
}
