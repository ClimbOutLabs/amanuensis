import { fireEvent, render, screen } from '@testing-library/react';
import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AmanSetupProvider, type AmanSetupState } from '@/components/AmanSetupContext.js';
import { greetingFor } from '@/components/AmanTour.js';
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
/** The tour's greeting, which depends on the hour the test runs at. */

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

    expect(await screen.findByTestId('aman-tour')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /How can I help/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replay the tour' })).not.toBeInTheDocument();
  });

  it('keeps a heading the runtime passes in, such as an active agent name, on the plain screen', async () => {
    renderWelcome({ assistantName: 'Testinatrix', heading: 'Repo Reviewer' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Repo Reviewer' })).toBeInTheDocument();
    expect(screen.queryByTestId('aman-tour')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide the tour' })).not.toBeInTheDocument();
  });

  it('sends the brief ticket through the composer and then sends it', async () => {
    renderWelcome({ setup: { modelName: 'local/llama', hasChatted: false, firstRunGuide: notDismissed } });

    fireEvent.click(await screen.findByRole('button', { name: /Your brief is ready/ }));

    expect(composer.setText).toHaveBeenCalledWith(MORNING_BRIEF_PROMPT);
    expect(composer.send).toHaveBeenCalledTimes(1);
    expect(composer.setText.mock.invocationCallOrder[0]).toBeLessThan(composer.send.mock.invocationCallOrder[0] ?? 0);
  });

  it('sends a capability chip through the composer', async () => {
    renderWelcome({ setup: { modelName: 'local/llama', hasChatted: false, firstRunGuide: notDismissed } });

    fireEvent.click(await screen.findByRole('button', { name: 'Run things on a schedule' }));

    expect(composer.setText).toHaveBeenCalledWith('Every weekday at 7:30, send me my morning brief.');
    expect(composer.send).toHaveBeenCalledTimes(1);
  });

  it('hides the email and calendar prompts until Google grants them', async () => {
    renderWelcome({ setup: { modelName: 'local/llama', hasChatted: false, firstRunGuide: notDismissed } });
    await screen.findByTestId('aman-tour');

    expect(screen.queryByRole('button', { name: /Find forgotten subscriptions/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep your calendar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read files and run code' })).not.toBeInTheDocument();
  });

  it('shows the capability tickets an instance has the capability for', async () => {
    server.grantedFeatures = ['gmail_read', 'calendar_read'];
    server.sandboxEnabled = true;
    renderWelcome({ setup: { modelName: 'local/llama', hasChatted: false, firstRunGuide: notDismissed } });

    expect(await screen.findByRole('button', { name: /Handle your email/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Find forgotten subscriptions/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Keep pages in Spaces/ })).toBeInTheDocument();
  });

  it('hides the Google prompts when the host has no Google port at all', async () => {
    server.hasCatalog = false;
    server.sandboxEnabled = true;
    renderWelcome({ setup: { modelName: 'local/llama', hasChatted: false, firstRunGuide: notDismissed } });
    await screen.findByTestId('aman-tour');

    expect(screen.queryByRole('button', { name: /Handle your email/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run things on a schedule/ })).toBeInTheDocument();
  });

  it('turns the cards off and says why when no model is set', async () => {
    renderWelcome({
      setup: { modelName: null, hasChatted: false, firstRunGuide: notDismissed, settingsHref: '/settings' },
    });

    expect(await screen.findByRole('button', { name: /Your brief is ready/ })).toBeDisabled();
    expect(screen.getByText('Choose a model in Settings before you start a chat.')).toBeInTheDocument();
  });
});

describe('the setup line in the tour', () => {
  it('shows how many lines are set up, linking to the first open one', async () => {
    renderWelcome({
      setup: { modelName: null, hasChatted: false, firstRunGuide: notDismissed, settingsHref: '/settings' },
    });

    expect(await screen.findByRole('link', { name: '0 of 3 set up →' })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('heading', { name: 'Get set up' })).not.toBeInTheDocument();
  });

  it('drops the line once every line is done', async () => {
    renderWelcome({
      userName: 'Sam',
      setup: { modelName: 'local/llama', hasChatted: true, firstRunGuide: notDismissed },
    });

    expect(await screen.findByTestId('aman-tour')).toBeInTheDocument();
    expect(screen.queryByTestId('aman-first-run-summary')).not.toBeInTheDocument();
  });

  it('asks for the name in that line once the owner has put the guide away', async () => {
    renderWelcome({
      userName: null,
      setup: { modelName: 'local/llama', hasChatted: false, firstRunGuide: dismissed, settingsHref: '/settings' },
    });

    expect(await screen.findByTestId('aman-name-prompt')).toHaveTextContent('Aman does not know your name yet.');
    expect(screen.queryByTestId('aman-first-run-summary')).not.toBeInTheDocument();
  });
});

describe('hiding and bringing back the tour', () => {
  it('hides the tour for the owner, shows the plain greeting, and brings the tour back on request', async () => {
    const { unmount } = renderWelcome({
      assistantName: 'Testinatrix',
      setup: { modelName: 'local/llama', hasChatted: true, firstRunGuide: dismissed },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Hide the tour' }));

    expect(await screen.findByRole('heading', { name: `${greetingFor(new Date())}.` })).toBeInTheDocument();
    expect(window.localStorage.getItem(TOUR_HIDDEN_STORAGE_KEY)).toBe('true');
    unmount();

    renderWelcome({
      assistantName: 'Testinatrix',
      setup: { modelName: 'local/llama', hasChatted: true, firstRunGuide: dismissed },
    });
    expect(await screen.findByRole('button', { name: 'Replay the tour' })).toBeInTheDocument();
    expect(screen.queryByTestId('aman-tour')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Replay the tour' }));
    expect(await screen.findByTestId('aman-tour')).toBeInTheDocument();
    expect(window.localStorage.getItem(TOUR_HIDDEN_STORAGE_KEY)).toBe('false');
  });

  it('keeps the plain greeting for a stored hide, and the checklist on the plain screen while it is open', async () => {
    window.localStorage.setItem(TOUR_HIDDEN_STORAGE_KEY, 'true');
    renderWelcome({ setup: { modelName: null, hasChatted: false, firstRunGuide: notDismissed } });

    expect(await screen.findByRole('heading', { name: `${greetingFor(new Date())}.` })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Get set up' })).toBeInTheDocument();
    expect(screen.queryByTestId('aman-tour')).not.toBeInTheDocument();
  });
});

describe('amanWelcomeHeading', () => {
  it('greets the person by name at the time of day, and without a name when there is none', () => {
    expect(amanWelcomeHeading({ name: 'Priya', now: new Date(2026, 0, 1, 9) })).toBe('Good morning, Priya.');
    expect(amanWelcomeHeading({ name: '  ', now: new Date(2026, 0, 1, 14) })).toBe('Good afternoon.');
    expect(amanWelcomeHeading({ name: undefined, now: new Date(2026, 0, 1, 20) })).toBe('Good evening.');
  });
});

describe('AmanWelcome assistant name', () => {
  it('shows no Aman anywhere on the first frame once the owner names the assistant', async () => {
    renderWelcome({
      assistantName: 'Maya',
      setup: { modelName: 'local/llama', hasChatted: false, firstRunGuide: notDismissed },
    });

    expect(await screen.findByTestId('aman-tour')).toBeInTheDocument();
    expect(screen.getByTestId('aman-tour').textContent).toContain('Maya is your chief of staff');
    expect(screen.getByTestId('aman-tour').textContent).not.toMatch(/Aman/);
  });
});
