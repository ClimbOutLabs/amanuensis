import {
  PersonalizationProvider,
  RunCodeStatusProvider,
  ThemeProvider,
  TrueForgeUI,
  type PersonalizationApi,
  type PersonalizationProfile,
} from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

/**
 * The Settings page with every tab the fixture host can back, opened from a fresh load. Network
 * calls are answered with empty lists, so the tabs render without a server. Everything on screen
 * is invented.
 */
const params = new URLSearchParams(window.location.search);
const mode = params.get('theme') === 'dark' ? 'dark' : 'light';

const emptyFetch: typeof fetch = async () => new Response('[]', { status: 200 });

const EMPTY_PROFILE: PersonalizationProfile = {
  assistant_name: null,
  assistant_identity: null,
  voice_guidance: null,
  user_name: null,
  address_as: null,
  user_profile: null,
  pinned_preferences: [],
  help_areas: [],
  learned_profile: null,
  learning_enabled: false,
};

const personalizationApi: PersonalizationApi = {
  getProfile: async () => EMPTY_PROFILE,
  updateProfile: async next => next,
  deleteProfile: async () => {},
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <ThemeProvider theme={{ mode, brand: { mode: 'icon-title', name: 'Amanuensis' } }}>
    <div className="h-full bg-primary-bg text-text-primary">
      <PersonalizationProvider api={personalizationApi}>
        <RunCodeStatusProvider api={{ getRunCodeStatus: async () => ({ state: 'ready' }) }}>
          <TrueForgeUI
            server={{ type: 'trueforge', baseUrl: 'http://127.0.0.1/', fetch: emptyFetch }}
            layout="sidebar"
            initialSettingsOpen
          />
        </RunCodeStatusProvider>
      </PersonalizationProvider>
    </div>
  </ThemeProvider>,
);
