import { PRESETS, TrueForgeUI, type ThemePreset } from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

function isPreset(value: string | null): value is ThemePreset {
  return value != null && Object.hasOwn(PRESETS, value);
}

const params = new URLSearchParams(window.location.search);
const presetParam = params.get('preset');
const preset = isPreset(presetParam) ? presetParam : 'trueforge';
const mode = params.get('mode') === 'dark' ? 'dark' : 'light';

// The edge check only needs the layout chrome, so every API call fails fast instead of reaching a backend.
const offlineFetch: typeof fetch = async () => new Response('{}', { status: 503 });

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

createRoot(rootElement).render(
  <TrueForgeUI
    server={{ type: 'trueforge', baseUrl: 'http://127.0.0.1/', fetch: offlineFetch }}
    layout="dock"
    theme={{ mode, preset }}
  />,
);
