import { Layout } from './components/Layout';
import { PageProvider, type PageContext } from './context';
import { About } from './pages/About';
import { Contact } from './pages/Contact';
import { Features } from './pages/Features';
import { Home } from './pages/Home';
import { Legal } from './pages/Legal';
import { NotFound } from './pages/NotFound';
import { Pricing } from './pages/Pricing';
import { Security } from './pages/Security';

export function App(ctx: PageContext) {
  return (
    <PageProvider value={ctx}>
      <Layout>
        <Page route={ctx.route} />
      </Layout>
    </PageProvider>
  );
}

function Page({ route }: Pick<PageContext, 'route'>) {
  switch (route) {
    case 'home':
      return <Home />;
    case 'features':
      return <Features />;
    case 'pricing':
      return <Pricing />;
    case 'about':
      return <About />;
    case 'security':
      return <Security />;
    case 'contact':
      return <Contact />;
    case 'privacy':
    case 'terms':
    case 'refunds':
    case 'cookies':
    case 'dataDeletion':
      return <Legal doc={route} />;
    case 'notFound':
      return <NotFound />;
  }
}
