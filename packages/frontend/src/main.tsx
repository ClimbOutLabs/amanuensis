import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
// KaTeX math rendering (see @truefoundry/trueforge-ui's Markdown atom): imported here, not in the
// UI package's inlined styles.css, so Vite resolves and copies the relative woff2 font URLs.
import 'katex/dist/katex.min.css';
import { installMonacoWorkerPublicPath } from './publicPath';

installMonacoWorkerPublicPath();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root not found');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
