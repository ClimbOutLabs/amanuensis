import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AmanSetupProvider, type AmanSetupState } from '@/components/AmanSetupContext.js';
import { AmanWelcome, amanWelcomeHeading } from '@/components/AmanWelcome.js';
import { EMPTY_PERSONALIZATION_PROFILE, PersonalizationProvider } from '@/components/PersonalizationContext.js';
import { TOUR_HIDDEN_STORAGE_KEY } from '@/utils/tourDisplayPreference.js';

const { composer, server } = vi.hoisted(() => {
  const server: { grantedFeatures: string[]; sandboxEnabled: boolean; hasCatalog: boolean } = {
    grantedFeatures: [],
    sandboxEnabled: false,
    hasCatalog: true,
  };
  return { composer: { setText: vi.fn(), send: vi.fn() }, server };
});

vi.mock('@assistant-ui/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@assistant-ui/react')>()),
  useAui: () => ({ composer: () => composer }),
}));

vi.mock('@/server/ServerContext.js', async importOriginal => ({
  ...(await importOriginal<typeof import('@/server/ServerContext.js')>()),
  useOptionalCatalogServer: () =>
    server.hasCatalog
      ? {
          getGoogleStatus: async () => ({
            features: ['gmail_read', 'gmail_compose', 'calendar_read', 'calendar_write'].map(feature => ({
              feature,
              granted: server.grantedFeatures.includes(feature),
              label: feature,
            })),
          }),
        }
      : null,
  useServerCapabilities: () => ({ sandbox: { enabled: server.sandboxEnabled } }),
}));

type RenderInput = {
  assistantName?: string | null;
  userName?: string | null;
  setup?: AmanSetupState;
  heading?: string;
};

function renderWelcome(input: RenderInput = {}) {
  const api = {
    getProfile: async () => ({
      ...EMPTY_PERSONALIZATION_PROFILE,
      assistant_name: input.assistantName ?? null,
      user_name: input.userName ?? null,
    }),
    updateProfile: async () => ({ ...EMPTY_PERSONALIZATION_PROFILE }),
    deleteProfile: async () => {},
  };
  const screenElement = <AmanWelcome heading={input.heading} />;
  return render(
    <PersonalizationProvider api={api}>
      {input.setup === undefined ? (
        screenElement
      ) : (
        <AmanSetupProvider value={input.setup}>{screenElement}</AmanSetupProvider>
      )}
    </PersonalizationProvider>,
  );
}

const dismissed = { dismissed: true, dismiss: () => {} };
const notDismissed = { dismissed: false, dismiss: () => {} };
const TOUR_HEADING = 'Try a day with Aman';

beforeEach(() => {
  window.localStorage.clear();
  composer.setText.mockClear();
  composer.send.mockClear();
  server.grantedFeatures = [];
  server.sandboxEnabled = false;
  server.hasCatalog = true;
});

afterEach(() => {
  window.localStorage.clear();
});

describe('AmanWelcome on an ordinary new chat', () => {
  it('shows the tour in place of the plain greeting', async () => {
    renderWelcome({ assistantName: 'Testinatrix' });

    expect(await screen.findByRole('heading', { name: TOUR_HEADING })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /How can I help/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show the tour' })).not.toBeInTheDocument();
  });

  it('keeps a heading the runtime passes in, such as an active agent name, on the plain screen', async () => {
    renderWelcome({ assistantName: 'Testinatrix', heading: 'Repo Reviewer' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Repo Reviewer' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: TOUR_HEADING })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide the tour' })).not.toBeInTheDocument();
  });

  it('sends a day card through the composer and then sends it', async () => {
    renderWelcome({ setup: { modelName: 'local/llama', hasChatted: false, firstRunGuide: notDismissed } });

    fireEvent.click(await screen.findByRole('button', { name: /Your morning brief/ }));

    expect(composer.setText).toHaveBeenCalledWith('Good morning! Give me my brief for today.');
    expect(composer.send).toHaveBeenCalledTimes(1);
    expect(composer.setText.mock.invocationCallOrder[0]).toBeLessThan(composer.send.mock.invocationCallOrder[0] ?? 0);
  });

  it('sends a capability chip through the composer', async () => {
    renderWelcome({ setup: { modelName: 'local/llama', hasChatted: false, firstRunGuide: notDismissed } });

    fireEvent.click(await screen.findByRole('button', { name: 'Run things on a schedule' }));

    expect(composer.setText).toHaveBeenCalledWith('Set up a routine that checks my bills every Friday.');
    expect(composer.send).toHaveBeenCalledTimes(1);
  });

  it('hides the email and calendar prompts until Google grants them', async () => {
    renderWelcome({ setup: { modelName: 'local/llama', hasChatted: false, firstRunGuide: notDismissed } });
    await screen.findByRole('heading', { name: TOUR_HEADING });

    expect(screen.queryByRole('button', { name: /Check for scams/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep your calendar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read files and run code' })).not.toBeInTheDocument();
  });

  it('shows the prompts an instance has the capability for', async () => {
    server.grantedFeatures = ['gmail_read', 'calendar_read'];
    server.sandboxEnabled = true;
    renderWelcome({ setup: { modelName: 'local/llama', hasChatted: false, firstRunGuide: notDismissed } });

    expect(await screen.findByRole('button', { name: /Check for scams/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Help me with doctor's appointments/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep your calendar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read files and run code' })).toBeInTheDocument();
  });

  it('hides the Google prompts when the host has no Google port at all', async () => {
    server.hasCatalog = false;
    server.sandboxEnabled = true;
    renderWelcome({ setup: { modelName: 'local/llama', hasChatted: false, firstRunGuide: notDismissed } });
    await screen.findByRole('heading', { name: TOUR_HEADING });

    expect(screen.queryByRole('button', { name: 'Handle your email' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read files and run code' })).toBeInTheDocument();
  });

  it('turns the cards off and says why when no model is set', async () => {
    renderWelcome({
      setup: { modelName: null, hasChatted: false, firstRunGuide: notDismissed, settingsHref: '/settings' },
    });

    expect(await screen.findByRole('button', { name: /Your morning brief/ })).toBeDisabled();
    expect(screen.getByText('Choose a model in Settings before you start a chat.')).toBeInTheDocument();
  });
});

describe('the setup block in the tour', () => {
  it('shows the Get set up checklist at the top while setup is incomplete', async () => {
    renderWelcome({
      setup: { modelName: null, hasChatted: false, firstRunGuide: notDismissed, settingsHref: '/settings' },
    });

    expect(await screen.findByRole('heading', { name: 'Get set up' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Setup checklist' })).toHaveTextContent('Add a model');
    expect(screen.getByRole('link', { name: 'Choose a model' })).toHaveAttribute('href', '/settings');
  });

  it('drops the checklist once every line is done', async () => {
    renderWelcome({
      userName: 'Sam',
      setup: { modelName: 'local/llama', hasChatted: true, firstRunGuide: notDismissed },
    });

    expect(await screen.findByRole('heading', { name: TOUR_HEADING })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Get set up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'You are all set' })).not.toBeInTheDocument();
  });

  it('shows the name line instead of the checklist once the owner has put the checklist away', async () => {
    renderWelcome({
      userName: null,
      setup: { modelName: 'local/llama', hasChatted: false, firstRunGuide: dismissed, settingsHref: '/settings' },
    });

    expect(await screen.findByTestId('aman-name-prompt')).toHaveTextContent('Aman does not know your name yet.');
    expect(screen.queryByRole('heading', { name: 'Get set up' })).not.toBeInTheDocument();
  });
});

describe('hiding and bringing back the tour', () => {
  it('hides the tour for the owner, shows the plain greeting, and brings the tour back on request', async () => {
    const { unmount } = renderWelcome({
      assistantName: 'Testinatrix',
      setup: { modelName: 'local/llama', hasChatted: true, firstRunGuide: dismissed },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Hide the tour' }));

    expect(
      await screen.findByRole('heading', { name: "Hi, I'm Testinatrix. What's on your mind?" }),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem(TOUR_HIDDEN_STORAGE_KEY)).toBe('true');
    unmount();

    renderWelcome({
      assistantName: 'Testinatrix',
      setup: { modelName: 'local/llama', hasChatted: true, firstRunGuide: dismissed },
    });
    expect(await screen.findByRole('button', { name: 'Show the tour' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: TOUR_HEADING })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show the tour' }));
    expect(await screen.findByRole('heading', { name: TOUR_HEADING })).toBeInTheDocument();
    expect(window.localStorage.getItem(TOUR_HIDDEN_STORAGE_KEY)).toBe('false');
  });

  it('keeps the plain greeting for a stored hide, and the checklist on the plain screen while it is open', async () => {
    window.localStorage.setItem(TOUR_HIDDEN_STORAGE_KEY, 'true');
    renderWelcome({ setup: { modelName: null, hasChatted: false, firstRunGuide: notDismissed } });

    expect(await screen.findByRole('heading', { name: 'How can I help you today?' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Get set up' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: TOUR_HEADING })).not.toBeInTheDocument();
  });
});

describe('amanWelcomeHeading', () => {
  it('names the assistant only when the owner picked a name', () => {
    expect(amanWelcomeHeading('Testinatrix')).toBe("Hi, I'm Testinatrix. What's on your mind?");
    expect(amanWelcomeHeading('  ')).toBe('How can I help you today?');
    expect(amanWelcomeHeading('')).toBe('How can I help you today?');
    expect(amanWelcomeHeading(undefined)).toBe('How can I help you today?');
  });
});
