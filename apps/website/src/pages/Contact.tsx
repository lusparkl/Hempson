import { CompanyDetails, ContactList, PageHero } from '../components/Layout';
import { usePage } from '../context';

/** No contact form on purpose: it would need a public endpoint and spam protection. Links only. */
export function Contact() {
  const { d } = usePage();
  const p = d.pages.contact;
  return (
    <>
      <PageHero title={p.title} intro={p.intro} />
      <section aria-labelledby="write-title">
        <h2 id="write-title">{p.write}</h2>
        <ContactList />
        <p className="note">{p.hours}</p>
      </section>
      <section aria-labelledby="company-title">
        <h2 id="company-title">{p.company}</h2>
        <CompanyDetails />
      </section>
    </>
  );
}
