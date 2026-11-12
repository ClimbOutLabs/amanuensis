import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MORNING_BRIEF_CARD_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AmanSetupProvider, type AmanSetupState } from '@/components/AmanSetupContext.js';
import { AmanWelcome } from '@/components/AmanWelcome.js';
import { EMPTY_PERSONALIZATION_PROFILE, PersonalizationProvider } from '@/components/PersonalizationContext.js';
import { CARDS } from '@/components/tourPrompts.js';

const { composer, server, schedules, shell, permissionsServer } = vi.hoisted(() => {
  type AccountState = 'connected' | 'not_connected' | 'sign_in_stopped' | 'not_working';
  const server: {
    grantedFeatures: string[];
    hasCatalog: boolean;
    /** The account saved in Settings, Connectors, Email; null means this host has no email port. */
    email: AccountState | null;
    calendar: AccountState | null;
    emailReadFails: boolean;
  } = { grantedFeatures: [], hasCatalog: true, email: null, calendar: null, emailReadFails: false };
  const schedules: {
    list: { id: string; name: string; task: string; status: 'active' | 'paused' }[];
    enabled: boolean;
    /** What the person may do on each schedule; null means no permissions server, so everything is allowed. */
    permissions: Record<string, string[]> | null;
  } = {
    list: [],
    enabled: false,
    permissions: null,
  };
  // One object for the whole run: the permissions hook keys its reads on the server's identity.
  const permissionsServer = {
    listPermissions: async ({ resourceIds }: { resourceIds: readonly string[] }) => ({
      data: Object.fromEntries(resourceIds.map(id => [id, schedules.permissions?.[id] ?? []])),
    }),
  };
  return {
    composer: { setText: vi.fn(), send: vi.fn() },
    server,
    schedules,
    shell: { openHistorySession: vi.fn() },
    permissionsServer,
  };
});

const createScheduleRun = vi.fn(async ({ scheduleId }: { scheduleId: string }) => ({
  id: 'run-1',
  scheduleId,
  name: 'manual',
  scheduledFor: '2026-10-29T08:00:00.000Z',
  status: 'triggered',
  triggeredAt: '2026-10-29T08:00:00.000Z',
  triggeredBy: 'Priya',
}));
const findScheduleRunSession = vi.fn(async () => ({
  id: 'session-run-1',
  createdAt: '2026-10-29T08:00:00.000Z',
  agentName: 'assistant',
}));

vi.mock('@assistant-ui/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@assistant-ui/react')>()),
  useAui: () => ({ composer: () => composer }),
}));

vi.mock('@/server/ServerContext.js', async importOriginal => ({
  ...(await importOriginal<typeof import('@/server/ServerContext.js')>()),
  useOptionalCatalogServer: () =>
    server.hasCatalog
      ? {
          // The Google port sits on the connector catalog, as it does in the app.
          connectorCatalog: {
            getGoogleStatus: async () => ({
              features: ['gmail_read', 'calendar_read'].map(feature => ({
                feature,
                granted: server.grantedFeatures.includes(feature),
                label: feature,
              })),
            }),
            ...(server.email === null
              ? {}
              : {
                  getEmailStatus: async () => {
                    if (server.emailReadFails) throw new Error('The email status could not be read.');
                    return { available: true, state: server.email };
                  },
                }),
            ...(server.calendar === null
              ? {}
              : { getCalendarStatus: async () => ({ available: true, state: server.calendar }) }),
          },
        }
      : null,
  useServerCapabilities: () => ({ sandbox: { enabled: false } }),
  useOptionalScheduleServer: () =>
    schedules.enabled ? { listSchedules: async () => ({ data: schedules.list }), createScheduleRun } : null,
  useOptionalAgentSessionsServer: () => ({ findScheduleRunSession }),
  useOptionalPermissionsServer: () => (schedules.permissions === null ? null : permissionsServer),
}));

vi.mock('@/server/ShellModeContext.js', async importOriginal => ({
  ...(await importOriginal<typeof import('@/server/ShellModeContext.js')>()),
  useOptionalShellMode: () => shell,
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
  return render(
    <PersonalizationProvider api={api}>
      {input.setup === undefined ? (
        <AmanWelcome heading={input.heading} />
      ) : (
        <AmanSetupProvider value={input.setup}>
          <AmanWelcome heading={input.heading} />
        </AmanSetupProvider>
      )}
    </PersonalizationProvider>,
  );
}

const firstRun: AmanSetupState = {
  modelName: 'local/llama',
  hasChatted: false,
  firstRunGuide: { dismissed: false, dismiss: () => {} },
};

beforeEach(() => {
  localStorage.clear();
  composer.setText.mockClear();
  composer.send.mockClear();
  server.grantedFeatures = [];
  server.hasCatalog = true;
  server.email = null;
  server.calendar = null;
  server.emailReadFails = false;
  schedules.list = [];
  schedules.enabled = false;
  schedules.permissions = null;
  createScheduleRun.mockClear();
  findScheduleRunSession.mockClear();
  shell.openHistorySession.mockClear();
});

describe('AmanWelcome on an ordinary new chat', () => {
  it('shows the home in place of the plain heading', async () => {
    renderWelcome({ userName: 'Priya Shah', assistantName: 'Mannie' });

    expect(await screen.findByRole('heading', { level: 1, name: /Good .*Priya/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /How can I help/ })).not.toBeInTheDocument();
  });

  it('keeps a heading the runtime passes in, such as an active agent name, on the plain screen', async () => {
    renderWelcome({ heading: 'Repo Reviewer', setup: firstRun });

    expect(await screen.findByRole('heading', { level: 1, name: 'Repo Reviewer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "I'm behind" })).not.toBeInTheDocument();
  });

  it('chooses a pill without sending, then a card tap starts a turn with the card prompt', async () => {
    renderWelcome({ setup: { ...firstRun, hasChatted: true } });

    fireEvent.click(await screen.findByRole('button', { name: 'Help me think' }));
    expect(composer.send).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /I can't get started/ }));
    expect(composer.setText).toHaveBeenCalledWith(CARDS.start.prompt);
    expect(composer.send).toHaveBeenCalledTimes(1);
  });

  it('sends only the morning brief card prompt from the brief card', async () => {
    server.grantedFeatures = ['gmail_read', 'calendar_read'];
    renderWelcome({ setup: firstRun });

    fireEvent.click(await screen.findByRole('button', { name: /Your morning brief/ }));
    expect(composer.setText).toHaveBeenCalledWith(MORNING_BRIEF_CARD_PROMPT);
    expect(composer.send).toHaveBeenCalledTimes(1);
  });

  it('with no model only fills the composer from a card and shows the model line', async () => {
    renderWelcome({ setup: { ...firstRun, modelName: null } });

    expect(await screen.findByText('Choose a model in Settings before you start a chat.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /I can't get started/ }));
    expect(composer.setText).toHaveBeenCalledWith(CARDS.start.prompt);
    expect(composer.send).not.toHaveBeenCalled();
  });

  it('shows the setup ticket on a first run and puts it away with Skip for good', async () => {
    const dismiss = vi.fn();
    renderWelcome({ setup: { ...firstRun, firstRunGuide: { dismissed: false, dismiss } } });

    expect(await screen.findByTestId('aman-setup-ticket')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip the tour' }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('drops the prompt line, the ticket and Skip once the first chat is sent, and keeps the pills and cards', async () => {
    renderWelcome({ setup: { ...firstRun, hasChatted: true } });

    expect(await screen.findByRole('button', { name: "I'm behind" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Everything's in my head/ })).toBeInTheDocument();
    expect(screen.queryByTestId('aman-setup-ticket')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip the tour' })).not.toBeInTheDocument();
  });

  it('hides the first-run lines once the owner has skipped them', async () => {
    renderWelcome({ setup: { ...firstRun, firstRunGuide: { dismissed: true, dismiss: () => {} } } });

    expect(await screen.findByRole('button', { name: "I'm behind" })).toBeInTheDocument();
    expect(screen.queryByTestId('aman-setup-ticket')).not.toBeInTheDocument();
    expect(screen.queryByText(/What would help you most\? Pick one/)).not.toBeInTheDocument();
  });
});

describe('the mail and calendar cards', () => {
  const PLAN_PILL = "Something's coming up";
  const chatted: AmanSetupState = { ...firstRun, hasChatted: true };

  async function openPills() {
    fireEvent.click(await screen.findByRole('button', { name: "I'm behind" }));
    const mail = screen.queryByRole('button', { name: /What am I dropping\?/ });
    fireEvent.click(screen.getByRole('button', { name: PLAN_PILL }));
    const calendar = screen.queryByRole('button', { name: /Get me ready for the next one/ });
    return { mail, calendar };
  }

  it('hides both when nothing is connected', async () => {
    server.email = 'not_connected';
    server.calendar = 'not_connected';
    renderWelcome({ setup: chatted });

    const cards = await openPills();
    expect(cards.mail).toBeNull();
    expect(cards.calendar).toBeNull();
  });

  it('shows the mail cards when an email account is connected in Settings, with no Google sign-in', async () => {
    server.email = 'connected';
    server.calendar = 'not_connected';
    renderWelcome({ setup: chatted });

    fireEvent.click(await screen.findByRole('button', { name: "I'm behind" }));
    expect(await screen.findByRole('button', { name: /What am I dropping\?/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: PLAN_PILL }));
    expect(screen.queryByRole('button', { name: /Get me ready for the next one/ })).not.toBeInTheDocument();
  });

  it('shows the calendar cards when a calendar account is connected in Settings, with no Google sign-in', async () => {
    server.email = 'not_connected';
    server.calendar = 'connected';
    renderWelcome({ setup: chatted });

    fireEvent.click(await screen.findByRole('button', { name: PLAN_PILL }));
    expect(await screen.findByRole('button', { name: /Get me ready for the next one/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "I'm behind" }));
    expect(screen.queryByRole('button', { name: /What am I dropping\?/ })).not.toBeInTheDocument();
  });

  it('still shows the calendar cards when the email read fails', async () => {
    server.email = 'connected';
    server.emailReadFails = true;
    server.calendar = 'connected';
    renderWelcome({ setup: chatted });

    fireEvent.click(await screen.findByRole('button', { name: PLAN_PILL }));
    expect(await screen.findByRole('button', { name: /Get me ready for the next one/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "I'm behind" }));
    expect(screen.queryByRole('button', { name: /What am I dropping\?/ })).not.toBeInTheDocument();
  });

  it.each(['sign_in_stopped', 'not_working'] as const)(
    'hides the cards for a saved account that is %s',
    async accountState => {
      server.email = accountState;
      server.calendar = accountState;
      renderWelcome({ setup: chatted });

      const cards = await openPills();
      expect(cards.mail).toBeNull();
      expect(cards.calendar).toBeNull();
    },
  );

  it('shows both through Google alone, as before', async () => {
    server.grantedFeatures = ['gmail_read', 'calendar_read'];
    renderWelcome({ setup: chatted });

    fireEvent.click(await screen.findByRole('button', { name: "I'm behind" }));
    expect(await screen.findByRole('button', { name: /What am I dropping\?/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: PLAN_PILL }));
    expect(screen.getByRole('button', { name: /Get me ready for the next one/ })).toBeInTheDocument();
  });
});

describe('the run my daily brief card', () => {
  const brief = {
    id: 'sched-brief',
    name: 'morning-brief',
    task: 'My brief. Travel from 12 Elm Road.',
    status: 'active' as const,
  };
  const plants = {
    id: 'sched-plants',
    name: 'water-plants',
    task: 'Remind me to water the plants.',
    status: 'active' as const,
  };
  const pausedBrief = { ...brief, id: 'sched-brief-paused', status: 'paused' as const };

  it('shows when the person has a daily brief schedule', async () => {
    schedules.enabled = true;
    schedules.list = [plants, brief];
    renderWelcome({ setup: { ...firstRun, hasChatted: true } });

    expect(await screen.findByRole('button', { name: /Run my daily brief/ })).toBeInTheDocument();
  });

  it('stays hidden when no schedule is a daily brief', async () => {
    schedules.enabled = true;
    schedules.list = [plants];
    renderWelcome({ setup: { ...firstRun, hasChatted: true } });

    expect(await screen.findByRole('button', { name: "I'm behind" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Run my daily brief/ })).not.toBeInTheDocument());
  });

  it('starts a run of that schedule, as Run now does, and opens the chat the run writes into', async () => {
    schedules.enabled = true;
    schedules.list = [brief];
    renderWelcome({ setup: { ...firstRun, hasChatted: true } });

    fireEvent.click(await screen.findByRole('button', { name: /Run my daily brief/ }));
    await waitFor(() =>
      expect(shell.openHistorySession).toHaveBeenCalledWith({ sessionId: 'session-run-1', agentName: 'assistant' }),
    );
    expect(createScheduleRun).toHaveBeenCalledWith({ scheduleId: 'sched-brief' });
    expect(findScheduleRunSession).toHaveBeenCalledWith({ scheduleId: 'sched-brief', runId: 'run-1' });
    expect(composer.send).not.toHaveBeenCalled();
  });

  it('starts one run from two fast taps, and shows the card busy until the run has started', async () => {
    schedules.enabled = true;
    schedules.list = [brief];
    let finishStart: (() => void) | undefined;
    createScheduleRun.mockImplementationOnce(
      ({ scheduleId }) =>
        new Promise(resolve => {
          finishStart = () =>
            resolve({
              id: 'run-1',
              scheduleId,
              name: 'manual',
              scheduledFor: '2026-10-29T08:00:00.000Z',
              status: 'triggered',
              triggeredAt: '2026-10-29T08:00:00.000Z',
              triggeredBy: 'Priya',
            });
        }),
    );
    renderWelcome({ setup: { ...firstRun, hasChatted: true } });

    const card = await screen.findByRole('button', { name: /Run my daily brief/ });
    fireEvent.click(card);
    fireEvent.click(card);
    expect(createScheduleRun).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(card).toBeDisabled());
    expect(card).toHaveTextContent('Starting...');
    fireEvent.click(card);
    expect(createScheduleRun).toHaveBeenCalledTimes(1);

    finishStart?.();
    await waitFor(() => expect(shell.openHistorySession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(card).toBeEnabled());
    expect(card).not.toHaveTextContent('Starting...');
  });

  it('stays hidden when the person may not manage the brief schedule', async () => {
    schedules.enabled = true;
    schedules.list = [brief];
    schedules.permissions = { 'sched-brief': ['READ'] };
    renderWelcome({ setup: { ...firstRun, hasChatted: true } });

    expect(await screen.findByRole('button', { name: "I'm behind" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Run my daily brief/ })).not.toBeInTheDocument());
  });

  it('runs the brief schedule the person may manage, not the one they may only read', async () => {
    schedules.enabled = true;
    schedules.list = [brief, pausedBrief];
    schedules.permissions = { 'sched-brief': ['READ'], 'sched-brief-paused': ['READ', 'MANAGE'] };
    renderWelcome({ setup: { ...firstRun, hasChatted: true } });

    fireEvent.click(await screen.findByRole('button', { name: /Run my daily brief/ }));
    await waitFor(() => expect(createScheduleRun).toHaveBeenCalledWith({ scheduleId: 'sched-brief-paused' }));
  });

  it('prefers an active brief schedule over a paused one listed first', async () => {
    schedules.enabled = true;
    schedules.list = [pausedBrief, brief];
    renderWelcome({ setup: { ...firstRun, hasChatted: true } });

    fireEvent.click(await screen.findByRole('button', { name: /Run my daily brief/ }));
    await waitFor(() => expect(createScheduleRun).toHaveBeenCalledWith({ scheduleId: 'sched-brief' }));
  });

  it('falls back to a paused brief schedule when no brief is active', async () => {
    schedules.enabled = true;
    schedules.list = [plants, pausedBrief];
    renderWelcome({ setup: { ...firstRun, hasChatted: true } });

    fireEvent.click(await screen.findByRole('button', { name: /Run my daily brief/ }));
    await waitFor(() => expect(createScheduleRun).toHaveBeenCalledWith({ scheduleId: 'sched-brief-paused' }));
  });
});
