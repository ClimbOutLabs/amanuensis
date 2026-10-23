import { fireEvent, render, screen, within } from '@testing-library/react';
import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import type { HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AmanSetupProvider, type AmanSetupState } from '@/components/AmanSetupContext.js';
import { AmanWelcome, AmanWelcomeFooter, amanWelcomeHeading } from '@/components/AmanWelcome.js';
import { EMPTY_PERSONALIZATION_PROFILE, PersonalizationProvider } from '@/components/PersonalizationContext.js';
import { TOUR_HIDDEN_STORAGE_KEY } from '@/utils/tourDisplayPreference.js';

const { composer, server } = vi.hoisted(() => {
  const server: {
    grantedFeatures: string[];
    sandboxEnabled: boolean;
    hasCatalog: boolean;
  } = {
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
  helpAreas?: HelpAreaId[];
  setup?: AmanSetupState;
  heading?: string;
};

function renderHome(input: RenderInput = {}) {
  const api = {
    getProfile: async () => ({
      ...EMPTY_PERSONALIZATION_PROFILE,
      assistant_name: input.assistantName ?? null,
      user_name: input.userName ?? null,
      help_areas: input.helpAreas ?? [],
    }),
    updateProfile: async () => ({ ...EMPTY_PERSONALIZATION_PROFILE }),
    deleteProfile: async () => {},
  };
  // The thread renders the footer after the composer, and only on an ordinary new chat.
  const screenElement = (
    <>
      <AmanWelcome heading={input.heading} />
      {input.heading === undefined ? <AmanWelcomeFooter /> : null}
    </>
  );
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
const LIVE_SETUP: AmanSetupState = { modelName: 'local/llama', hasChatted: false, firstRunGuide: notDismissed };

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

describe('the home greeting', () => {
  it('shows the greeting as the heading, with the underline accent and no eyebrow line', async () => {
    const { container } = renderHome({ assistantName: 'Maya', userName: 'Priya', setup: LIVE_SETUP });

    const heading = await screen.findByRole('heading', {
      level: 1,
      name: /^Good (morning|afternoon|evening), Priya\.$/,
    });
    expect(heading.querySelector('.aui-underline')).not.toBeNull();
    expect(container.textContent).not.toMatch(/chief of staff/i);
  });

  it('shows no description sentence and no status line, first run or not', async () => {
    const { container } = renderHome({ assistantName: 'Maya', setup: LIVE_SETUP });

    await screen.findByTestId('aman-tour');
    expect(container.textContent).not.toMatch(/keeps track of your day/);
    expect(container.textContent).not.toMatch(
      /Your brief is ready|Nothing needs you|Quietly watching|run on a schedule/,
    );
  });

  it('keeps a heading the runtime passes in, such as an active agent name, on the plain screen', async () => {
    renderHome({ assistantName: 'Maya', heading: 'Repo Reviewer' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Repo Reviewer' })).toBeInTheDocument();
    expect(screen.queryByTestId('aman-tour')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show the tour' })).not.toBeInTheDocument();
  });
});

describe('the Productivity pill', () => {
  it('holds the brief first, and sends it through the composer', async () => {
    renderHome({ helpAreas: ['productivity'], setup: LIVE_SETUP });

    const starters = await screen.findByRole('list', { name: 'Starter suggestions' });
    fireEvent.click(within(starters).getByRole('button', { name: 'Open the brief' }));

    expect(composer.setText).toHaveBeenCalledWith(MORNING_BRIEF_PROMPT);
    expect(composer.send).toHaveBeenCalledTimes(1);
    expect(composer.setText.mock.invocationCallOrder[0]).toBeLessThan(composer.send.mock.invocationCallOrder[0] ?? 0);
  });

  it('turns its links off and says why when no model is set', async () => {
    renderHome({
      helpAreas: ['productivity'],
      setup: { modelName: null, hasChatted: false, firstRunGuide: notDismissed, settingsHref: '/settings' },
    });

    const starters = await screen.findByRole('list', { name: 'Starter suggestions' });
    expect(within(starters).getByRole('button', { name: 'Open the brief' })).toBeDisabled();
    expect(screen.getByText('Choose a model in Settings before you start a chat.')).toBeInTheDocument();
  });
});

describe('the starters and the tour below the composer', () => {
  it('offers no starters until the person picks a help area', async () => {
    renderHome({ setup: LIVE_SETUP });
    await screen.findByTestId('aman-tour');

    expect(screen.queryByRole('list', { name: 'Starter suggestions' })).not.toBeInTheDocument();
  });

  it('offers at most three starters from the picked area', async () => {
    renderHome({ helpAreas: ['focus'], setup: LIVE_SETUP });

    const starters = await screen.findByRole('list', { name: 'Starter suggestions' });
    expect(within(starters).getAllByRole('button')).toHaveLength(3);
  });

  it('opens the tour the first time, with its chooser and cards', async () => {
    renderHome({ assistantName: 'Maya', setup: LIVE_SETUP });

    const tour = await screen.findByTestId('aman-tour');
    expect(within(tour).getByRole('radiogroup', { name: 'What would help you most?' })).toBeInTheDocument();
    expect(within(tour).getByRole('heading', { name: 'Some things Maya can do' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show the tour' })).not.toBeInTheDocument();
  });

  it('hides the Google prompts until Google grants them', async () => {
    renderHome({ setup: LIVE_SETUP });
    await screen.findByTestId('aman-tour');

    expect(screen.queryByRole('button', { name: /Find forgotten subscriptions/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep your calendar' })).not.toBeInTheDocument();
  });

  it('hides the tour for the owner and brings it back with Show the tour', async () => {
    renderHome({ assistantName: 'Maya', setup: LIVE_SETUP });

    fireEvent.click(await screen.findByRole('button', { name: 'Hide the tour' }));

    expect(await screen.findByRole('button', { name: 'Show the tour' })).toBeInTheDocument();
    expect(screen.queryByTestId('aman-tour')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(TOUR_HIDDEN_STORAGE_KEY)).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Show the tour' }));

    expect(await screen.findByTestId('aman-tour')).toBeInTheDocument();
    expect(window.localStorage.getItem(TOUR_HIDDEN_STORAGE_KEY)).toBe('false');
  });

  it('keeps the tour hidden on a later visit when the owner put it away', async () => {
    window.localStorage.setItem(TOUR_HIDDEN_STORAGE_KEY, 'true');
    renderHome({ setup: LIVE_SETUP });

    expect(await screen.findByRole('button', { name: 'Show the tour' })).toBeInTheDocument();
    expect(screen.queryByTestId('aman-tour')).not.toBeInTheDocument();
  });

  it('shows the checklist on the plain screen while the tour is hidden', async () => {
    window.localStorage.setItem(TOUR_HIDDEN_STORAGE_KEY, 'true');
    renderHome({ setup: { modelName: null, hasChatted: false, firstRunGuide: notDismissed } });

    expect(await screen.findByRole('heading', { name: 'Get set up' })).toBeInTheDocument();
  });
});

describe('the setup line', () => {
  it('shows how many lines are set up, linking to the first open one', async () => {
    renderHome({
      setup: { modelName: null, hasChatted: false, firstRunGuide: notDismissed, settingsHref: '/settings' },
    });

    expect(await screen.findByRole('link', { name: '0 of 3 set up →' })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('heading', { name: 'Get set up' })).not.toBeInTheDocument();
  });

  it('asks for the name once the owner has put the guide away', async () => {
    renderHome({
      userName: null,
      setup: { modelName: 'local/llama', hasChatted: false, firstRunGuide: dismissed, settingsHref: '/settings' },
    });

    expect(await screen.findByTestId('aman-name-prompt')).toHaveTextContent('Aman does not know your name yet.');
    expect(screen.queryByTestId('aman-first-run-summary')).not.toBeInTheDocument();
  });
});

describe('amanWelcomeHeading', () => {
  it('greets the person by name at the time of day, and without a name when there is none', () => {
    expect(amanWelcomeHeading({ name: 'Priya', now: new Date(2026, 0, 1, 9) })).toBe('Good morning, Priya.');
    expect(amanWelcomeHeading({ name: '  ', now: new Date(2026, 0, 1, 14) })).toBe('Good afternoon.');
    expect(amanWelcomeHeading({ name: undefined, now: new Date(2026, 0, 1, 20) })).toBe('Good evening.');
  });
});

describe('the assistant name on the home', () => {
  it('shows no Aman anywhere once the owner names the assistant', async () => {
    const { container } = renderHome({ assistantName: 'Maya', userName: 'Priya', setup: LIVE_SETUP });

    await screen.findByTestId('aman-tour');
    expect(container.textContent).toContain('Some things Maya can do');
    expect(container.textContent).not.toMatch(/Aman/);
  });
});
