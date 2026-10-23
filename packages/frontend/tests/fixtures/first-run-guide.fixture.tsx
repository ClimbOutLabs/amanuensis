import {
  AmanSetupProvider,
  AmanWelcome,
  PersonalizationProvider,
  ThemeProvider,
  TrueForgeUI,
  type AmanSetupState,
  type PersonalizationApi,
  type PersonalizationProfile,
} from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

/**
 * Home screens in the states the browser test photographs: a first run with nothing set up, one
 * line done, the first chat sent, a morning brief on hand, Skip taken, and the full shell. Everything
 * on screen is invented.
 */
export type FixtureState = 'fresh' | 'half' | 'done' | 'brief' | 'skipped' | 'shell';
export const FIXTURE_STATES: readonly FixtureState[] = ['fresh', 'half', 'done', 'brief', 'skipped', 'shell'];

function isFixtureState(value: string | null): value is FixtureState {
  return FIXTURE_STATES.some(state => state === value);
}

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

function profileFor(state: FixtureState): PersonalizationProfile {
  if (state === 'fresh' || state === 'half') {
    return EMPTY_PROFILE;
  }
  return { ...EMPTY_PROFILE, assistant_name: 'Mannie', user_name: 'Sam Rivera', address_as: 'Sam' };
}

function setupFor(state: FixtureState): AmanSetupState {
  // A first run has no model yet, so "Add a model" is the open line; the other states have one.
  const base = { settingsHref: '/settings', modelName: state === 'fresh' ? null : 'local/qwen3-8b' };
  switch (state) {
    case 'fresh':
    case 'half':
    case 'shell':
      return { ...base, hasChatted: false, firstRunGuide: { dismissed: false, dismiss: () => {} } };
    case 'done':
      return { ...base, hasChatted: true, firstRunGuide: { dismissed: false, dismiss: () => {} } };
    case 'brief':
      return { ...base, hasChatted: true, hasBrief: true, firstRunGuide: { dismissed: false, dismiss: () => {} } };
    case 'skipped':
      return { ...base, hasChatted: false, firstRunGuide: { dismissed: true, dismiss: () => {} } };
  }
}

/**
 * The real chat shell: top bar, the first frame and the composer together, with every network call
 * answered by an empty list. Sized to the viewport so the page itself must not scroll.
 */
const shellFetch: typeof fetch = async input => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/sessions')) return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
  return new Response('{}', { status: 503 });
};

function staticApi(profile: PersonalizationProfile): PersonalizationApi {
  return {
    getProfile: async () => profile,
    updateProfile: async next => next,
    deleteProfile: async () => {},
  };
}

function Screen({ state }: { state: FixtureState }) {
  if (state === 'shell') {
    return (
      <div className="overflow-hidden" style={{ height: '100vh' }}>
        <TrueForgeUI
          server={{ type: 'trueforge', baseUrl: 'http://127.0.0.1/', fetch: shellFetch }}
          layout="sidebar"
          overrides={{ WelcomeScreen: AmanWelcome }}
        />
      </div>
    );
  }
  return (
    <div className="flex min-h-screen flex-col">
      <AmanWelcome />
    </div>
  );
}

const params = new URLSearchParams(window.location.search);
const stateParam = params.get('state');
const state: FixtureState = isFixtureState(stateParam) ? stateParam : 'fresh';
const mode = params.get('theme') === 'dark' ? 'dark' : 'light';

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

createRoot(rootElement).render(
  <ThemeProvider theme={{ mode, brand: { mode: 'icon-title', name: 'Amanuensis' } }}>
    <div className="min-h-screen bg-primary-bg text-text-primary" data-fixture-state={state}>
      <PersonalizationProvider api={staticApi(profileFor(state))}>
        <AmanSetupProvider value={setupFor(state)}>
          <Screen state={state} />
        </AmanSetupProvider>
      </PersonalizationProvider>
    </div>
  </ThemeProvider>,
);
