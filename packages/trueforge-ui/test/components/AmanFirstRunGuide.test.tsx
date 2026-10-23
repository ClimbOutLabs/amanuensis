import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AmanSetupTicket, setupTicketItems } from '@/components/AmanFirstRunGuide.js';
import { AmanSetupProvider, type AmanSetupState } from '@/components/AmanSetupContext.js';
import { EMPTY_PERSONALIZATION_PROFILE, PersonalizationProvider } from '@/components/PersonalizationContext.js';

function renderTicket({
  assistantName = null,
  userName = null,
  setup,
}: {
  assistantName?: string | null;
  userName?: string | null;
  setup: AmanSetupState;
}) {
  const api = {
    getProfile: async () => ({ ...EMPTY_PERSONALIZATION_PROFILE, assistant_name: assistantName, user_name: userName }),
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
  modelName: null,
  hasChatted: false,
  firstRunGuide: { dismissed: false, dismiss: () => {} },
  settingsHref: '/settings',
};

describe('setupTicketItems', () => {
  it('lists the three steps in order, with the actions that open Settings', () => {
    const items = setupTicketItems({
      assistantName: 'Mannie',
      modelName: null,
      userName: null,
      hasChatted: false,
    });

    expect(items.map(item => item.label)).toEqual(['Add a model', 'Tell Mannie about you', 'Try your first chat']);
    expect(items[0]?.action).toEqual({ label: 'Choose a model', target: { kind: 'settings', section: 'models' } });
    expect(items[1]?.action).toEqual({
      label: 'Open Personalization',
      target: { kind: 'settings', section: 'personalization' },
    });
    expect(items[2]?.action).toBeUndefined();
  });

  it('marks each step done from its own state', () => {
    const items = setupTicketItems({
      assistantName: 'Mannie',
      modelName: 'local/llama',
      userName: 'Sidd',
      hasChatted: true,
    });

    expect(items.map(item => item.done)).toEqual([true, true, true]);
    expect(items[0]?.doneValue).toBe('local/llama');
    expect(items[1]?.doneValue).toBe('Sidd');
  });

  it('counts a blank model or name as not set', () => {
    const items = setupTicketItems({
      assistantName: 'Mannie',
      modelName: '  ',
      userName: '   ',
      hasChatted: false,
    });

    expect(items.map(item => item.done)).toEqual([false, false, false]);
  });

  it('leaves out the first-chat step when the host does not know whether a chat started', () => {
    const items = setupTicketItems({ assistantName: 'Mannie', modelName: null, userName: null, hasChatted: undefined });

    expect(items.map(item => item.key)).toEqual(['model', 'about-you']);
  });
});

describe('AmanSetupTicket', () => {
  it('shows the count, the three steps and the open actions', async () => {
    renderTicket({ assistantName: 'Mannie', userName: 'Sidd', setup: { ...open, modelName: 'local/llama' } });

    expect(await screen.findByRole('heading', { name: 'Set up Mannie' })).toBeInTheDocument();
    expect(screen.getByText('2 of 3 done')).toBeInTheDocument();
    expect(screen.getByText('Add a model')).toBeInTheDocument();
    expect(screen.getByText('Tell Mannie about you')).toBeInTheDocument();
    expect(screen.getByText('Try your first chat')).toBeInTheDocument();
    // Both finished lines show their value, and no action is left to offer.
    expect(screen.getByText('Sidd')).toBeInTheDocument();
    expect(screen.queryByText('Choose a model')).not.toBeInTheDocument();
    expect(screen.queryByText('Open Personalization')).not.toBeInTheDocument();
  });

  it('names the assistant in the about-you step, never a fixed name', async () => {
    renderTicket({ assistantName: 'Juniper', setup: open });

    expect(await screen.findByText('Tell Juniper about you')).toBeInTheDocument();
    expect(screen.queryByText(/Aman|Mannie/)).not.toBeInTheDocument();
  });

  it('hides once every step is done', async () => {
    const { container } = renderTicket({
      assistantName: 'Mannie',
      userName: 'Sidd',
      setup: { ...open, modelName: 'local/llama', hasChatted: true },
    });

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing once the owner has skipped it', () => {
    const { container } = renderTicket({
      assistantName: 'Mannie',
      setup: { ...open, firstRunGuide: { dismissed: true, dismiss: () => {} } },
    });

    expect(container).toBeEmptyDOMElement();
  });
});
