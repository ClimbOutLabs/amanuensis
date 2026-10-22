import { TrueForgeUI } from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

/** The real chat shell against stubbed routes. Every API call fails fast, so no chat rows show. */
const stubFetch: typeof fetch = async () => new Response('{}', { status: 503 });

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

createRoot(rootElement).render(
  <TrueForgeUI server={{ type: 'trueforge', baseUrl: 'http://127.0.0.1/', fetch: stubFetch }} layout="sidebar" />,
);
