import { createRoot } from 'react-dom/client';
import { App } from './App';
import '../../../packages/ui/src/styles.css';
import './style.css';

createRoot(document.getElementById('root')!).render(<App />);
