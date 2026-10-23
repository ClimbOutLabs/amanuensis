import { fireEvent, render, screen } from '@testing-library/react';
import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AmanSetupProvider, type AmanSetupState } from '@/components/AmanSetupContext.js';
import { AmanWelcome } from '@/components/AmanWelcome.js';
import { EMPTY_PERSONALIZATION_PROFILE, PersonalizationProvider } from '@/components/PersonalizationContext.js';

const { composer, server } = vi.hoisted(() => {
  const server: { grantedFeatures: string[]; hasCatalog: boolean } = { grantedFeatures: [], hasCatalog: true };
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
            features: ['gmail_read', 'calendar_read'].map(feature => ({
              feature,
              granted: server.grantedFeatures.includes(feature),
              label: feature,
            })),
          }),
        }
      : null,
  useServerCapabilities: () => ({ sandbox: { enabled: false } }),
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
  composer.setText.mockClear();
  composer.send.mockClear();
  server.grantedFeatures = [];
  server.hasCatalog = true;
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
    expect(screen.queryByRole('button', { name: 'Productivity' })).not.toBeInTheDocument();
  });

  it('starts the morning brief from Productivity through the composer, and sends it', async () => {
    renderWelcome({ setup: firstRun });

    fireEvent.click(await screen.findByRole('button', { name: 'Productivity' }));

    expect(composer.setText).toHaveBeenCalledWith(MORNING_BRIEF_PROMPT);
    expect(composer.send).toHaveBeenCalledTimes(1);
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

    expect(await screen.findByRole('button', { name: 'Productivity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Draft a reply/ })).toBeInTheDocument();
    expect(screen.queryByTestId('aman-setup-ticket')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip the tour' })).not.toBeInTheDocument();
  });

  it('hides the first-run lines once the owner has skipped them', async () => {
    renderWelcome({ setup: { ...firstRun, firstRunGuide: { dismissed: true, dismiss: () => {} } } });

    expect(await screen.findByRole('button', { name: 'Productivity' })).toBeInTheDocument();
    expect(screen.queryByTestId('aman-setup-ticket')).not.toBeInTheDocument();
    expect(screen.queryByText(/What would help you most\? Pick one/)).not.toBeInTheDocument();
  });
});
