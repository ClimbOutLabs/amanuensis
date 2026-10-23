import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AmanSetupTicket, setupTicketItems } from '@/components/AmanFirstRunGuide.js';
import { AmanSetupProvider, type AmanSetupState } from '@/components/AmanSetupContext.js';
import { EMPTY_PERSONALIZATION_PROFILE, PersonalizationProvider } from '@/components/PersonalizationContext.js';

const { server } = vi.hoisted(() => {
  const server: { grantedFeatures: string[]; scheduleCount: number } = { grantedFeatures: [], scheduleCount: 0 };
  return { server };
});

vi.mock('@/server/ServerContext.js', async importOriginal => ({
  ...(await importOriginal<typeof import('@/server/ServerContext.js')>()),
  useOptionalCatalogServer: () => ({
    getGoogleStatus: async () => ({
      features: ['gmail_read', 'calendar_read'].map(feature => ({
        feature,
        granted: server.grantedFeatures.includes(feature),
        label: feature,
      })),
    }),
  }),
  useOptionalScheduleServer: () => ({
    listSchedules: async () => ({ data: Array.from({ length: server.scheduleCount }, () => ({})) }),
  }),
}));

function renderTicket({ assistantName = null, setup }: { assistantName?: string | null; setup: AmanSetupState }) {
  const api = {
    getProfile: async () => ({ ...EMPTY_PERSONALIZATION_PROFILE, assistant_name: assistantName }),
    updateProfile: async () => ({ ...EMPTY_PERSONALIZATION_PROFILE }),
    deleteProfile: async () => {},
  };
  return render(
    <PersonalizationProvider api={api}>
      <AmanSetupProvider value={setup}>
        <AmanSetupTicket />
      </AmanSetupProvider>
    </PersonalizationProvider>,
  );
}

const open: AmanSetupState = {
  modelName: 'local/llama',
  firstRunGuide: { dismissed: false, dismiss: () => {} },
  settingsHref: '/settings',
};

describe('setupTicketItems', () => {
  it('marks each line done from its own state', () => {
    const items = setupTicketItems({ assistantName: 'Mannie', googleReady: false, scheduleCount: 0 });

    expect(items.map(item => [item.label, item.done])).toEqual([
      ['Pick a name', true],
      ['Connect Gmail and Calendar', false],
      ['Choose when the morning brief arrives', false],
    ]);
    expect(items[2]?.verb).toBe('Pick a time');
  });

  it('counts a blank name as unset and a schedule as the brief time being set', () => {
    const items = setupTicketItems({ assistantName: '   ', googleReady: true, scheduleCount: 1 });

    expect(items[0]?.done).toBe(false);
    expect(items[2]?.done).toBe(true);
  });
});

describe('AmanSetupTicket', () => {
  beforeEach(() => {
    server.grantedFeatures = [];
    server.scheduleCount = 0;
  });

  it('shows the count, the open lines with their verbs, and the finished name', async () => {
    renderTicket({ assistantName: 'Mannie', setup: open });

    expect(await screen.findByRole('heading', { name: 'Set up Mannie' })).toBeInTheDocument();
    expect(screen.getByText('1 of 3 done')).toBeInTheDocument();
    expect(screen.getByText('Connect')).toBeInTheDocument();
    expect(screen.getByText('Pick a time')).toBeInTheDocument();
    expect(screen.getByText('Mannie')).toBeInTheDocument();
  });

  it('hides once every line is done', async () => {
    server.grantedFeatures = ['gmail_read', 'calendar_read'];
    server.scheduleCount = 2;
    const { container } = renderTicket({ assistantName: 'Mannie', setup: open });

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing once the owner has skipped it', () => {
    const { container } = renderTicket({
      assistantName: 'Mannie',
      setup: { ...open, firstRunGuide: { dismissed: true, dismiss: () => {} } },
    });

    expect(container).toBeEmptyDOMElement();
  });
});
