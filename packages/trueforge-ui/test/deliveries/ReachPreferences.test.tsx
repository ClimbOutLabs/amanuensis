// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PersonalizationProvider, type PersonalizationProfile } from '@/components/PersonalizationContext.js';
import { ReachPreferences } from '@/deliveries/ReachPreferences.js';
import type { ReachView } from '@/deliveries/types.js';

import { fakeServer } from './fakeDeliveriesApi.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPreferences({ callsReady = false }: { callsReady?: boolean } = {}) {
  const server = fakeServer([]);
  if (callsReady) {
    server.state.reach = {
      ...server.state.reach,
      availability: {
        ...server.state.reach.availability,
        calls: { available: true, note: 'Calls are on.', problem: null },
      },
    };
  }
  render(<ReachPreferences reach={server.api.reach} />);
  return server;
}

describe('Settings, Reach me mail trouble', () => {
  const profile: PersonalizationProfile = {
    assistant_name: 'Mira',
    assistant_identity: null,
    voice_guidance: null,
    user_name: null,
    address_as: null,
    user_profile: null,
    pinned_preferences: [],
    help_areas: [],
    learned_profile: null,
    learning_enabled: false,
  };

  function renderWithProblem(mailProblem: ReachView['mailProblem']) {
    const server = fakeServer([]);
    server.state.reach = { ...server.state.reach, mailProblem };
    render(
      <PersonalizationProvider
        api={{ getProfile: async () => profile, updateProfile: async next => next, deleteProfile: async () => {} }}
      >
        <ReachPreferences reach={server.api.reach} />
      </PersonalizationProvider>,
    );
  }

  it('says nothing while mail checks work', async () => {
    renderWithProblem(null);
    await screen.findByRole('checkbox', { name: /Texts/ });
    expect(screen.queryByText(/has not been able to check your mail/)).toBeNull();
  });

  it('says in plain words which mail is watched, and nothing before mail was checked', async () => {
    const server = fakeServer([]);
    server.state.reach = { ...server.state.reach, mailSource: 'email_connector' };
    render(
      <PersonalizationProvider
        api={{ getProfile: async () => profile, updateProfile: async next => next, deleteProfile: async () => {} }}
      >
        <ReachPreferences reach={server.api.reach} />
      </PersonalizationProvider>,
    );
    expect(await screen.findByText('Mira is watching the mail from the shared Email connector.')).toBeTruthy();
  });

  it('says, with the assistant’s own name, since when mail was not checked and the one thing to do', async () => {
    renderWithProblem({ since: '2026-11-05T14:00:00.000Z', kind: 'other' });
    const notice = await screen.findByText(/Mira has not been able to check your mail since/);
    expect(notice.textContent).toMatch(/^Mira has not been able to check your mail since .+\.$/);
    expect(screen.getByText('Open Settings, Connectors, and check that your mail is still connected.')).toBeTruthy();
  });

  it('tells a slow mail server apart from other trouble', async () => {
    renderWithProblem({ since: '2026-11-05T14:00:00.000Z', kind: 'too_slow' });
    await screen.findByText(/has not been able to check your mail since/);
    expect(
      screen.getByText('Wait for Mira to catch up. If this lasts a day, ask whoever runs your mail.'),
    ).toBeTruthy();
    expect(screen.queryByText(/still connected/)).toBeNull();
  });

  it.each([
    ['google_sign_in', 'Open Settings, Connectors, Google and choose Reconnect to sign in to Google again.'],
    ['email_password', 'Open Settings, Connectors, Email. Make a new app password and save it again.'],
  ] as const)('gives its own step for %s', async (kind, step) => {
    renderWithProblem({ since: '2026-11-05T14:00:00.000Z', kind });
    await screen.findByText(/has not been able to check your mail since/);
    expect(screen.getByText(step)).toBeTruthy();
  });

  it('says since when the calendar was not checked', async () => {
    const server = fakeServer([]);
    server.state.reach = {
      ...server.state.reach,
      calendarProblem: { since: '2026-11-05T14:00:00.000Z', kind: 'google_sign_in' },
    };
    render(
      <PersonalizationProvider
        api={{ getProfile: async () => profile, updateProfile: async next => next, deleteProfile: async () => {} }}
      >
        <ReachPreferences reach={server.api.reach} />
      </PersonalizationProvider>,
    );
    const notice = await screen.findByText(/Mira has not been able to check your calendar since/);
    expect(notice.textContent).toMatch(/^Mira has not been able to check your calendar since .+\.$/);
    expect(
      screen.getByText('Open Settings, Connectors, Google and choose Reconnect to sign in to Google again.'),
    ).toBeTruthy();
  });
});

describe('Settings, Reach me preferences', () => {
  it('shows texts and calls as off and unavailable, with the plain-words note', async () => {
    renderPreferences();
    const texts = await screen.findByRole('checkbox', { name: /Texts/ });
    const calls = screen.getByRole('checkbox', { name: /Phone calls/ });
    expect(texts).toHaveProperty('disabled', true);
    expect(calls).toHaveProperty('disabled', true);
    expect(
      screen.getByText(/Texts are not set up on this server\. To set them up, follow the Text messages page/),
    ).toBeTruthy();
    expect(screen.getByText('Phone calls are not set up yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try texts' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Try calls' })).toHaveProperty('disabled', true);
  });

  it('hides what only matters for calls until phone calls are set up, and says so', async () => {
    renderPreferences();
    expect(await screen.findByText('Call settings appear here once phone calls are set up.')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Time to leave/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Call me for reminders I mark urgent' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Hold calls back during quiet hours' })).toBeNull();
    expect(screen.queryByLabelText('Fewest hours between two calls')).toBeNull();
    // What applies to nudges and notes stays.
    expect(screen.getByLabelText('Most nudges in one day')).toBeTruthy();
    expect(screen.getByLabelText('Time zone')).toBeTruthy();
  });

  it('starts with nothing ticked for calls, and offers the tick only for kinds that can call', async () => {
    renderPreferences({ callsReady: true });
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
    const { api } = renderPreferences({ callsReady: true });
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
    const { api } = renderPreferences({ callsReady: true });
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

  it('says what to do next when loading fails with no message of its own', async () => {
    const server = fakeServer([]);
    vi.mocked(server.api.reach.get).mockRejectedValueOnce('offline');
    render(<ReachPreferences reach={server.api.reach} />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your Reach me settings could not be loaded. Reload the page.',
    );
  });

  it('says to try again later when a test fails with no message of its own', async () => {
    const { api } = renderPreferences();
    vi.mocked(api.reach.test).mockRejectedValueOnce('offline');
    fireEvent.click(await screen.findByRole('button', { name: 'Try push' }));
    expect(await screen.findByText('That test did not go through. Try again in a minute.')).toBeTruthy();
  });

  describe('texts, once the server has a text provider', () => {
    function renderWithTexts() {
      const server = fakeServer([]);
      server.state.reach = {
        ...server.state.reach,
        availability: {
          ...server.state.reach.availability,
          texts: { available: true, note: 'Texts travel through Twilio and the phone company.', problem: null },
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
      expect(screen.getByText(/“Mannie: a reminder is due\. Open the app to see it\.”/)).toBeTruthy();
      fireEvent.click(screen.getByRole('radio', { name: /Full/ }));
      await waitFor(() => expect(api.reach.texts.setMode).toHaveBeenCalledWith('full'));

      fireEvent.click(screen.getByRole('checkbox', { name: /Send me texts/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.reach.save).toHaveBeenCalledWith(expect.objectContaining({ textsOn: true })));
    });

    it('shows a problem with texts beside them while texts still work', async () => {
      const server = fakeServer([]);
      const words = 'STOP replies do not reach Aman yet. Ask the person who runs Aman to check the Twilio settings.';
      server.state.reach = {
        ...server.state.reach,
        saved: true,
        availability: { ...server.state.reach.availability, texts: { available: true, note: 'On.', problem: words } },
      };
      server.state.texts = {
        phone: '+15550111',
        confirmed: true,
        mode: 'private',
        optedOut: false,
        codePending: false,
        pendingPhone: null,
        privatePreview: 'Mannie: a reminder is due. Open the app to see it.',
        words: [],
      };
      render(<ReachPreferences reach={server.api.reach} />);
      expect(await screen.findByText(words)).toBeTruthy();
    });

    it('turns texts off and forgets the number on remove', async () => {
      const server = fakeServer([]);
      server.state.reach = {
        ...server.state.reach,
        settings: { ...server.state.reach.settings, textsOn: true },
        saved: true,
        availability: { ...server.state.reach.availability, texts: { available: true, note: 'On.', problem: null } },
      };
      server.state.texts = {
        phone: '+15550111',
        confirmed: true,
        mode: 'private',
        optedOut: false,
        codePending: false,
        pendingPhone: null,
        privatePreview: 'Mannie: a reminder is due. Open the app to see it.',
        words: [],
      };
      render(<ReachPreferences reach={server.api.reach} />);
      expect(await screen.findByRole('checkbox', { name: /Send me texts/ })).toHaveProperty('checked', true);
      expect(screen.getByRole('button', { name: 'Try texts' })).toHaveProperty('disabled', false);
      fireEvent.click(screen.getByRole('button', { name: 'Remove number' }));
      await waitFor(() => expect(server.api.reach.texts.remove).toHaveBeenCalled());
      expect(await screen.findByLabelText('Your phone number')).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: /Send me texts/ })).toBeNull();
    });

    it('keeps texts going to the confirmed number while a new one waits for its code', async () => {
      const server = fakeServer([]);
      server.state.reach = {
        ...server.state.reach,
        settings: { ...server.state.reach.settings, textsOn: true },
        saved: true,
        availability: { ...server.state.reach.availability, texts: { available: true, note: 'On.', problem: null } },
      };
      server.state.texts = {
        phone: '+15550111',
        confirmed: true,
        mode: 'private',
        optedOut: false,
        codePending: false,
        pendingPhone: null,
        privatePreview: 'Mannie: a reminder is due. Open the app to see it.',
        words: [],
      };
      render(<ReachPreferences reach={server.api.reach} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Change number' }));
      fireEvent.change(screen.getByLabelText('Your phone number'), { target: { value: '+15550122' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
      expect(await screen.findByText('Texts keep going to +15550111 until you confirm +15550122.')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Code from the text'), { target: { value: '123456' } });
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      expect(await screen.findByText('+15550122')).toBeTruthy();
      expect(screen.getByRole('checkbox', { name: /Send me texts/ })).toHaveProperty('checked', true);
    });

    it('says what a STOP did and what to do next', async () => {
      const server = fakeServer([]);
      server.state.reach = {
        ...server.state.reach,
        availability: { ...server.state.reach.availability, texts: { available: true, note: 'On.', problem: null } },
      };
      server.state.texts = {
        phone: '+15550111',
        confirmed: false,
        mode: 'private',
        optedOut: true,
        codePending: false,
        pendingPhone: null,
        privatePreview: 'Mannie: a reminder is due. Open the app to see it.',
        words: [],
      };
      render(<ReachPreferences reach={server.api.reach} />);
      expect(
        await screen.findByText(/You replied STOP, so texts are off\. To use them again, reply START/),
      ).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: /Send me texts/ })).toBeNull();
    });
  });
});

describe('Settings, Reach me background checks switch', () => {
  it('shows the switch off at first, with what it does in plain words', async () => {
    renderPreferences();
    const toggle = await screen.findByRole('switch', { name: /watch for things/ });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/checks your mail every 10 minutes, your calendar every 30 minutes/)).toBeTruthy();
    expect(screen.getByText(/Reminders you set work either way/)).toBeTruthy();
  });

  it('saves the switch at once, keeps other changes waiting for Save, and turns it off again', async () => {
    const { api } = renderPreferences();
    fireEvent.change(await screen.findByLabelText('Email address'), { target: { value: 'dana@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('switch', { name: /watch for things/ }));
    await waitFor(() => expect(api.reach.save).toHaveBeenCalledTimes(1));
    expect(api.reach.save).toHaveBeenLastCalledWith(expect.objectContaining({ noticingOn: true, alwaysImportant: [] }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /watch for things/ }).getAttribute('aria-checked')).toBe('true'),
    );
    // The sender added before the switch is still waiting for Save.
    expect(screen.getByText('dana@example.com')).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: /watch for things/ }));
    await waitFor(() => expect(api.reach.save).toHaveBeenCalledTimes(2));
    expect(api.reach.save).toHaveBeenLastCalledWith(expect.objectContaining({ noticingOn: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.reach.save).toHaveBeenCalledTimes(3));
    expect(api.reach.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        noticingOn: false,
        alwaysImportant: [expect.objectContaining({ address: 'dana@example.com' })],
      }),
    );
  });

  it('says what went wrong when the switch cannot be saved, and leaves it as it was', async () => {
    const { api } = renderPreferences();
    vi.mocked(api.reach.save).mockRejectedValueOnce(new Error('The server is not answering. Try again in a minute.'));
    fireEvent.click(await screen.findByRole('switch', { name: /watch for things/ }));
    expect(await screen.findByText('The server is not answering. Try again in a minute.')).toBeTruthy();
    expect(screen.getByRole('switch', { name: /watch for things/ }).getAttribute('aria-checked')).toBe('false');
  });
});
