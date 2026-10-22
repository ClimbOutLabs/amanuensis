import { HelpProvider, TrueForgeUI } from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

import { createHelpApi } from '../../src/helpApi';

/**
 * The real chat shell with the real help wiring, against stubbed routes. `health` picks the health
 * check answer (`ready`, `no_model`, `fail`); `iris` picks whether Iris can join (`joined`, `missing`,
 * `fail`). Everything on screen is invented.
 */
const params = new URLSearchParams(window.location.search);
const health = params.get('health') ?? 'ready';
const iris = params.get('iris') ?? 'joined';

const HEALTH_BODY = {
  checked_at: '2026-10-21T09:00:00Z',
  model_ready: health === 'ready',
  items: [],
  host_report: { state: 'ok', checked_at: '2026-10-21T08:55:00Z', message: null, next_step: null },
};

const stubFetch: typeof fetch = async input => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/api/v1/help/health-check')) {
    if (health === 'fail') return new Response('{}', { status: 503 });
    return new Response(JSON.stringify({ data: HEALTH_BODY }), { status: 200 });
  }
  return new Response('{}', { status: 503 });
};

const helpApi = createHelpApi({
  fetcher: stubFetch,
  listPersonas: () => {
    if (iris === 'fail') return Promise.reject(new Error('Iris could not be installed.'));
    if (iris === 'missing') return Promise.resolve([]);
    return Promise.resolve([{ id: 'iris', display_name: 'Iris', aliases: [], instructions: '', model_name: '' }]);
  },
});

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

// The chat routes fail fast so the layout chrome is what the test sees.
createRoot(rootElement).render(
  <HelpProvider api={helpApi}>
    <TrueForgeUI server={{ type: 'trueforge', baseUrl: 'http://127.0.0.1/', fetch: stubFetch }} layout="sidebar" />
  </HelpProvider>,
);
