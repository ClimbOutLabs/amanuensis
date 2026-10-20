import {
  AmanFirstRunGuide,
  AmanSetupProvider,
  AmanWelcome,
  PersonalizationPanel,
  PersonalizationProvider,
  ThemeProvider,
  type AmanSetupState,
  type PersonalizationApi,
  type PersonalizationProfile,
} from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

/**
 * Screens the first-run work adds, each in a known state, for the browser test to photograph:
 * the checklist fresh, half done and done, the quiet name line after dismissal, the checklist as
 * Settings shows it, and the Personalization page. Everything on screen is invented.
 */
export type FixtureState = 'fresh' | 'half' | 'done' | 'line' | 'settings' | 'panel';
export const FIXTURE_STATES: readonly FixtureState[] = ['fresh', 'half', 'done', 'line', 'settings', 'panel'];

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
  learned_profile: null,
  learning_enabled: false,
};

function profileFor(state: FixtureState): PersonalizationProfile {
  if (state === 'half' || state === 'done' || state === 'settings') {
    return { ...EMPTY_PROFILE, assistant_name: 'Aman', user_name: 'Sam Rivera', address_as: 'Sam' };
  }
  return EMPTY_PROFILE;
}

function setupFor(state: FixtureState): AmanSetupState {
  const base = { settingsHref: '/settings', firstRunGuide: { dismissed: state === 'line', dismiss: () => {} } };
  switch (state) {
    case 'fresh':
    case 'panel':
      return { ...base, modelName: null, hasChatted: false };
    case 'half':
    case 'settings':
      return { ...base, modelName: 'local/qwen3-8b', hasChatted: false };
    case 'done':
    case 'line':
      return { ...base, modelName: 'local/qwen3-8b', hasChatted: true };
  }
}

function staticApi(profile: PersonalizationProfile): PersonalizationApi {
  return {
    getProfile: async () => profile,
    updateProfile: async next => next,
    deleteProfile: async () => {},
  };
}

function Screen({ state }: { state: FixtureState }) {
  if (state === 'panel') {
    return (
      <div className="mx-auto flex max-w-3xl flex-col px-6 py-6">
        <PersonalizationPanel />
      </div>
    );
  }
  if (state === 'settings') {
    return (
      <div className="mx-auto flex max-w-3xl flex-col px-6 py-6">
        <AmanFirstRunGuide placement="settings" className="max-w-none" />
      </div>
    );
  }
  return (
    <div className="flex min-h-screen flex-col justify-center py-8">
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
