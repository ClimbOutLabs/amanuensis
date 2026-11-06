import { ThemeProvider } from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

import { BrowserLivePage } from '../../src/BrowserLivePage';

/**
 * The live browser page on its own. The test answers its calls to the live routes, so the page
 * renders with no server and no browser behind it. Everything on screen is invented.
 */
const params = new URLSearchParams(window.location.search);
const mode = params.get('theme') === 'dark' ? 'dark' : 'light';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('the fixture page has no root element');
}

createRoot(root).render(
  <ThemeProvider theme={{ mode, brand: { mode: 'icon-title', name: 'Amanuensis' } }}>
    <BrowserLivePage />
  </ThemeProvider>,
);
