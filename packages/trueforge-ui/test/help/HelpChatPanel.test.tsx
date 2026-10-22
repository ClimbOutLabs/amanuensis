// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HelpChatPanel, HelpChoices } from '@/help/HelpChatPanel.js';
import type { HelpHealthCheck } from '@/help/helpModel.js';
import { HelpProvider, useOptionalHelp, type HelpApi } from '@/help/HelpProvider.js';

const { sent, composerSend, composerSetText } = vi.hoisted(() => {
  const sent: string[] = [];
  const composerSetText = vi.fn((text: string) => {
    sent.push(text);
  });
  const composerSend = vi.fn();
  return { sent, composerSend, composerSetText };
});

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({
    composer: () => ({ setText: composerSetText, send: composerSend }),
  }),
}));

const HEALTHY: HelpHealthCheck = {
  checked_at: '2026-10-21T09:00:00Z',
  model_ready: true,
  items: [
    { id: 'model', name: 'Your model', status: 'pass', message: 'The model answered.', next_step: null },
    { id: 'connectors', name: 'Connectors', status: 'pass', message: 'All 2 connectors answered.', next_step: null },
    {
      id: 'sandbox',
      name: 'Sandbox',
      status: 'warn',
      message: 'The sandbox is not ready.',
      next_step: 'Check Settings, Sandbox.',
    },
  ],
  host_report: { state: 'ok', checked_at: '2026-10-20T08:30:00Z', message: null, next_step: null },
};

const NO_MODEL: HelpHealthCheck = {
  checked_at: '2026-10-21T09:00:00Z',
  model_ready: false,
  items: [
    {
      id: 'model',
      name: 'Your model',
      status: 'fail',
      message: 'No model is connected.',
      next_step: 'Add one in Settings, Models. Token Factory is one option.',
    },
    {
      id: 'connectors',
      name: 'Connectors',
      status: 'not_set_up',
      message: 'No connectors are set up yet.',
      next_step: null,
    },
  ],
  host_report: {
    state: 'missing',
    checked_at: null,
    message: 'No full check has been run yet. Run aman doctor on your computer.',
    next_step: null,
  },
};

type ApiOptions = { check: HelpHealthCheck; guideReady?: boolean; failCheck?: boolean };

function makeApi({ check, guideReady = true, failCheck = false }: ApiOptions) {
  const getHealthCheck = vi.fn(async () => {
    if (failCheck) {
      throw new Error('network down');
    }
    return check;
  });
  const ensureGuide = vi.fn(async () => guideReady);
  const api: HelpApi = { getHealthCheck, ensureGuide };
  return { api, getHealthCheck, ensureGuide };
}

/** Starts a help session the way the header button does, then shows the panel and the choices. */
function StartAndShow({
  screen = 'Settings, Connectors',
  lastError = 'Request failed (500).',
}: {
  screen?: string;
  lastError?: string | null;
}) {
  const help = useOptionalHelp();
  return (
    <>
      <button type="button" onClick={() => help?.start({ screen, lastError })}>
        start help
      </button>
      <HelpChatPanel />
      <HelpChoices />
    </>
  );
}

function renderHelp(options: ApiOptions & { screen?: string; lastError?: string | null }) {
  const made = makeApi(options);
  render(
    <HelpProvider api={made.api}>
      <StartAndShow screen={options.screen} lastError={options.lastError} />
    </HelpProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'start help' }));
  return made;
}

beforeEach(() => {
  sent.length = 0;
  composerSetText.mockClear();
  composerSend.mockClear();
});

describe('HelpChatPanel', () => {
  it('shows the model first and red, with its next step, when no model is connected', async () => {
    const { ensureGuide } = renderHelp({ check: NO_MODEL });

    const results = await screen.findByTestId('help-chat-results');
    const items = within(results).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Your model');
    expect(items[0]).toHaveTextContent('No model is connected.');
    expect(items[0]).toHaveTextContent('Add one in Settings, Models. Token Factory is one option.');
    expect(items[0]?.querySelector('.text-danger')).not.toBeNull();
    expect(within(results).getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(ensureGuide).not.toHaveBeenCalled();
    expect(composerSend).not.toHaveBeenCalled();
    expect(screen.queryByTestId('help-choices')).toBeNull();
  });

  it('keeps Iris out of the chat when the model did not answer, and offers Check again', async () => {
    const { getHealthCheck, ensureGuide } = renderHelp({
      check: {
        ...NO_MODEL,
        items: [
          {
            id: 'model',
            name: 'Your model',
            status: 'fail',
            message: 'The model did not answer in time.',
            next_step: 'Check the model key in Settings, Models. Then press Check again.',
          },
        ],
      },
    });

    expect(await screen.findByText('The model did not answer in time.')).toBeInTheDocument();
    expect(ensureGuide).not.toHaveBeenCalled();
    expect(composerSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(getHealthCheck).toHaveBeenCalledTimes(2));
  });

  it('says how to get help when the check itself cannot run', async () => {
    renderHelp({ check: HEALTHY, failCheck: true });

    expect(
      await screen.findByText('The check could not run. Check your connection, then press Check again.'),
    ).toBeInTheDocument();
    expect(composerSend).not.toHaveBeenCalled();
  });

  it('is all green when healthy, has Iris speak first, and shows the screen and last error', async () => {
    const { ensureGuide } = renderHelp({
      check: HEALTHY,
      screen: 'Settings, Connectors',
      lastError: 'Request failed (500).',
    });

    await waitFor(() => expect(composerSend).toHaveBeenCalledTimes(1));
    expect(ensureGuide).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    const message = sent[0] ?? '';
    expect(message.startsWith('Iris, ')).toBe(true);
    expect(message).toContain('You were on: Settings, Connectors.');
    expect(message).toContain('Last error: Request failed (500).');
    expect(message).toContain('- Your model: ok. The model answered.');
    expect(await screen.findByTestId('help-choices')).toBeInTheDocument();
    const disclosure = screen.getByText('What Iris was told').closest('details');
    expect(disclosure).toHaveTextContent('You were on: Settings, Connectors. Last error: Request failed (500).');
    const shownOutside = Array.from(screen.getByTestId('help-chat-results').querySelectorAll('p')).filter(
      paragraph => paragraph.closest('details') === null,
    );
    expect(shownOutside.some(paragraph => paragraph.textContent?.includes('You were on'))).toBe(false);
  });

  it('sends one hidden message only, even if the run is started twice', async () => {
    const { ensureGuide } = renderHelp({ check: HEALTHY });

    await waitFor(() => expect(composerSend).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(composerSend).toHaveBeenCalledTimes(1);
    expect(ensureGuide).toHaveBeenCalledTimes(1);
  });

  it('keeps the results and says Iris could not join when she is not installed', async () => {
    renderHelp({ check: HEALTHY, guideReady: false });

    expect(
      await screen.findByText(
        'Iris could not join this chat. Open a terminal on the computer running Aman and type: aman doctor. Then press Check again.',
      ),
    ).toBeInTheDocument();
    expect(composerSend).not.toHaveBeenCalled();
    expect(screen.queryByTestId('help-choices')).toBeNull();
  });

  it('sends a tapped choice as the person’s own message', async () => {
    renderHelp({ check: HEALTHY });
    await screen.findByTestId('help-choices');

    fireEvent.click(screen.getByRole('button', { name: 'Setting up a model' }));

    expect(composerSetText).toHaveBeenLastCalledWith('Setting up a model');
    expect(composerSend).toHaveBeenCalledTimes(2);
  });

  it('sends typed text from the free text box', async () => {
    renderHelp({ check: HEALTHY });
    await screen.findByTestId('help-choices');

    fireEvent.change(screen.getByPlaceholderText('Or tell Iris in your own words'), {
      target: { value: '  my inbox is empty  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(composerSetText).toHaveBeenLastCalledWith('my inbox is empty');
  });
});
