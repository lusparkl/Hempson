import { createRoot, hydrateRoot } from 'react-dom/client';
import { App } from './App';
import { observeAnimations } from './animations';
import type { PageContext } from './context';
import { headTags } from './head';
import { routeByPath } from './routes';
import '../../../packages/ui/src/styles.css';
import './styles.css';

document.documentElement.classList.add('js');

const root = document.getElementById('root')!;
const ctxNode = document.getElementById('page-ctx');

if (ctxNode) {
  // Prerendered page: hydrate with the exact context it was rendered with.
  const ctx = JSON.parse(ctxNode.textContent!) as PageContext;
  hydrateRoot(root, <App {...ctx} />);
} else {
  // `vite dev`: no prerendered HTML, so resolve the route from the URL and render from scratch.
  const route = routeByPath(location.pathname);
  document.head.insertAdjacentHTML('beforeend', headTags(route));
  createRoot(root).render(<App route={route} />);
}

requestAnimationFrame(() => observeAnimations());
