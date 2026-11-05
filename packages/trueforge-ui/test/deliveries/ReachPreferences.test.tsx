// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReachPreferences } from '@/deliveries/ReachPreferences.js';

import { fakeServer } from './fakeDeliveriesApi.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPreferences() {
  const server = fakeServer([]);
  render(<ReachPreferences reach={server.api.reach} />);
  return server;
}

describe('Settings, Reach me preferences', () => {
  it('shows texts and calls as off and unavailable, with the plain-words note', async () => {
    renderPreferences();
    const texts = await screen.findByRole('checkbox', { name: /Texts/ });
    const calls = screen.getByRole('checkbox', { name: /Phone calls/ });
    expect(texts).toHaveProperty('disabled', true);
    expect(calls).toHaveProperty('disabled', true);
    expect(screen.getByText(/Texts are not set up\. To set them up, add your Twilio details/)).toBeTruthy();
    expect(screen.getByText('Phone calls are not set up yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try texts' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Try calls' })).toHaveProperty('disabled', true);
  });

  it('offers calls once the server has them, with the privacy note beside Calls and a test call after saving', async () => {
    const server = fakeServer([]);
    const note =
      "Calls and texts travel through Twilio and the phone company. The assistant's voice and the transcript are made on your computer.";
    server.state.reach = {
      ...server.state.reach,
      availability: { ...server.state.reach.availability, calls: { available: true, note } },
    };
    render(<ReachPreferences reach={server.api.reach} />);
    const calls = await screen.findByRole('checkbox', { name: /Phone calls/ });
    expect(calls).toHaveProperty('disabled', false);
    expect(screen.getByText(note)).toBeTruthy();
    // A test call is offered only once calls are saved as on.
    expect(screen.getByRole('button', { name: 'Try calls' })).toHaveProperty('disabled', true);
    fireEvent.click(calls);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try calls' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Try calls' }));
    await waitFor(() => expect(server.api.reach.test).toHaveBeenCalledWith('call'));
    expect(await screen.findByText(/Calling your phone now\./)).toBeTruthy();
  });

  it('starts with nothing ticked for calls, and offers the tick only for kinds that can call', async () => {
    renderPreferences();
    await screen.findByRole('checkbox', { name: /Texts/ });
    expect(screen.getByRole('checkbox', { name: /Mail from someone on your always-important list/ })).toHaveProperty(
      'checked',
      false,
    );
    expect(screen.getByRole('checkbox', { name: /Two things on your calendar/ })).toHaveProperty('checked', false);
    expect(screen.getByRole('checkbox', { name: /Time to leave/ })).toHaveProperty('checked', false);
    expect(screen.queryByRole('checkbox', { name: /A bill or deadline/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /An approval waiting/ })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Call me for reminders I mark urgent' })).toHaveProperty(
      'checked',
      false,
    );
  });

  it('saves a ticked kind, an added sender and the urgent-reminder tick', async () => {
    const { api } = renderPreferences();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Time to leave/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Call me for reminders I mark urgent' }));
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'Dana@Example.com' } });
    fireEvent.change(screen.getByLabelText('Name (optional)'), { target: { value: 'Dana' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Dana (dana@example.com)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.reach.save).toHaveBeenCalledTimes(1));
    expect(api.reach.save).toHaveBeenCalledWith(
      expect.objectContaining({
        callKinds: ['travel'],
        callForUrgentReminders: true,
        alwaysImportant: [expect.objectContaining({ address: 'dana@example.com', name: 'Dana', source: 'settings' })],
      }),
    );
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('adds nothing from a memory suggestion until the person accepts it, and can turn one down', async () => {
    const server = fakeServer([]);
    server.state.suggestions = [
      { address: 'dana@example.com', memory: 'Dana is my sister.' },
      { address: 'sam@example.com', memory: 'Sam runs the club.' },
    ];
    render(<ReachPreferences reach={server.api.reach} />);
    expect(await screen.findByText('Dana is my sister.')).toBeTruthy();
    expect(screen.getByText('No one yet.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add dana@example.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'No thanks for sam@example.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(server.api.reach.save).toHaveBeenCalledTimes(1));
    expect(server.api.reach.save).toHaveBeenCalledWith(
      expect.objectContaining({
        alwaysImportant: [expect.objectContaining({ address: 'dana@example.com', source: 'memory' })],
        dismissedSuggestions: ['sam@example.com'],
      }),
    );
  });

  it('shows what the server said when a save is refused', async () => {
    const { api } = renderPreferences();
    vi.mocked(api.reach.save).mockRejectedValueOnce(
      new Error('Phone calls are not set up yet. Leave calls off for now.'),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Leave calls off for now.');
  });

  it('sends a test through a channel and says how many devices it reached', async () => {
    const { api } = renderPreferences();
    fireEvent.click(await screen.findByRole('button', { name: 'Try push' }));
    await waitFor(() => expect(api.reach.test).toHaveBeenCalledWith('push'));
    expect(await screen.findByText('Sent to 1 device.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try in-app' }));
    await waitFor(() => expect(api.reach.test).toHaveBeenCalledWith('in_app'));
  });

  it('turns quiet hours and limits into saved values', async () => {
    const { api } = renderPreferences();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Hold calls back during quiet hours' }));
    fireEvent.change(screen.getByLabelText('Most nudges in one day'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.reach.save).toHaveBeenCalled());
    expect(api.reach.save).toHaveBeenCalledWith(
      expect.objectContaining({
        quietHours: { enabled: false, start: '21:00', end: '08:00' },
        maxNudgesPerDay: 3,
      }),
    );
  });

  it('says so when the settings cannot be loaded', async () => {
    const server = fakeServer([]);
    vi.mocked(server.api.reach.get).mockRejectedValueOnce(new Error('The server is away.'));
    render(<ReachPreferences reach={server.api.reach} />);
    expect((await screen.findByRole('alert')).textContent).toBe('The server is away.');
  });

  describe('texts, once the server has a text provider', () => {
    function renderWithTexts() {
      const server = fakeServer([]);
      server.state.reach = {
        ...server.state.reach,
        availability: {
          ...server.state.reach.availability,
          texts: { available: true, note: 'Texts travel through Twilio and the phone company.' },
        },
      };
      render(<ReachPreferences reach={server.api.reach} />);
      return server;
    }

    it('asks for a number first, with nothing to switch on until it is confirmed', async () => {
      renderWithTexts();
      expect(await screen.findByLabelText('Your phone number')).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: /Send me texts/ })).toBeNull();
      expect(screen.getByText(/Nothing else is sent until then\./)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Try texts' })).toBeNull();
    });

    it('walks number, code, confirm, then Private by default, and saves texts on', async () => {
      const { api } = renderWithTexts();
      fireEvent.change(await screen.findByLabelText('Your phone number'), { target: { value: '+15550111' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
      await waitFor(() => expect(api.reach.texts.sendCode).toHaveBeenCalledWith('+15550111'));
      fireEvent.change(await screen.findByLabelText('Code from the text'), { target: { value: '000000' } });
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      expect((await screen.findByRole('alert')).textContent).toContain('You have 4 tries left.');
      fireEvent.change(screen.getByLabelText('Code from the text'), { target: { value: '123456' } });
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

      expect(await screen.findByText('+15550111')).toBeTruthy();
      const privateMode = screen.getByRole('radio', { name: /Private \(recommended\)/ });
      expect(privateMode).toHaveProperty('checked', true);
      expect(screen.getByText(/a reminder is due\. Open Aman to see it\./)).toBeTruthy();
      fireEvent.click(screen.getByRole('radio', { name: /Full/ }));
      await waitFor(() => expect(api.reach.texts.setMode).toHaveBeenCalledWith('full'));

      fireEvent.click(screen.getByRole('checkbox', { name: /Send me texts/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.reach.save).toHaveBeenCalledWith(expect.objectContaining({ textsOn: true })));
    });

    it('turns texts off and forgets the number on remove', async () => {
      const server = fakeServer([]);
      server.state.reach = {
        ...server.state.reach,
        settings: { ...server.state.reach.settings, textsOn: true },
        saved: true,
        availability: { ...server.state.reach.availability, texts: { available: true, note: 'On.' } },
      };
      server.state.texts = {
        phone: '+15550111',
        confirmed: true,
        mode: 'private',
        optedOut: false,
        codePending: false,
      };
      render(<ReachPreferences reach={server.api.reach} />);
      expect(await screen.findByRole('checkbox', { name: /Send me texts/ })).toHaveProperty('checked', true);
      expect(screen.getByRole('button', { name: 'Try texts' })).toHaveProperty('disabled', false);
      fireEvent.click(screen.getByRole('button', { name: 'Remove number' }));
      await waitFor(() => expect(server.api.reach.texts.remove).toHaveBeenCalled());
      expect(await screen.findByLabelText('Your phone number')).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: /Send me texts/ })).toBeNull();
    });

    it('says what a STOP did and what to do next', async () => {
      const server = fakeServer([]);
      server.state.reach = {
        ...server.state.reach,
        availability: { ...server.state.reach.availability, texts: { available: true, note: 'On.' } },
      };
      server.state.texts = {
        phone: '+15550111',
        confirmed: false,
        mode: 'private',
        optedOut: true,
        codePending: false,
      };
      render(<ReachPreferences reach={server.api.reach} />);
      expect(
        await screen.findByText(/You replied STOP, so texts are off\. To use them again, reply START/),
      ).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: /Send me texts/ })).toBeNull();
    });
  });
});
