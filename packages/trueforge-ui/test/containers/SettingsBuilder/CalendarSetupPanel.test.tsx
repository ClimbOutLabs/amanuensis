// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CalendarSetupPanel from '@/containers/SettingsBuilder/CalendarSetupPanel.js';
import type { CalendarAccountStatus, CalendarProviderInfo, CalendarSetupPort } from '@/server/calendarSetup.js';

// jsdom does not implement <dialog>.showModal()/close(); CenteredModal calls both.
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function showModal(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function close(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});

afterEach(() => {
  if (originalShowModal === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  else Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  if (originalClose === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  else Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  vi.restoreAllMocks();
});

const CANARY = 'CANARY-APP-PASSWORD-7f3d9';

const GOOGLE: CalendarProviderInfo = {
  key: 'google',
  name: 'Google',
  serverUrl: null,
  accountUrlTemplate: 'https://calendar.google.com/calendar/dav/{email}/user/',
  helpUrl: 'https://support.google.com/accounts/answer/185833',
  helpHint: 'Google: turn on 2-Step Verification, then make an app password at myaccount.google.com/apppasswords.',
  setupSteps: [
    'Turn on 2-Step Verification for your Google account, if it is not on yet. Google only offers app passwords after that.',
    'Open myaccount.google.com/apppasswords, type a name such as Aman, and select Create.',
    'Copy the 16-letter password Google shows. Google shows it only once.',
    'Pick Google below, type your Gmail address, and paste the app password. Leave the login name empty.',
  ],
};

const FASTMAIL: CalendarProviderInfo = {
  key: 'fastmail',
  name: 'Fastmail',
  serverUrl: 'https://caldav.fastmail.com/dav/',
  accountUrlTemplate: null,
  helpUrl: 'https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords',
  helpHint: 'Fastmail: make an app password under Settings, Privacy & Security.',
  setupSteps: [],
};

const GMX: CalendarProviderInfo = {
  key: 'gmx',
  name: 'GMX',
  serverUrl: null,
  accountUrlTemplate: null,
  helpUrl: 'https://support.gmx.com/security/2fa/application-specific-passwords.html',
  helpHint: 'GMX: make an application-specific password.',
  setupSteps: [],
};

const WEBDE: CalendarProviderInfo = {
  key: 'webde',
  name: 'web.de',
  serverUrl: 'https://caldav.web.de',
  accountUrlTemplate: null,
  helpUrl: null,
  helpHint: 'web.de: make an application-specific password.',
  setupSteps: [],
};

const OTHER: CalendarProviderInfo = {
  key: 'other',
  name: 'Other',
  serverUrl: null,
  accountUrlTemplate: null,
  helpUrl: null,
  helpHint: "Your calendar provider's help pages explain how to make an app password.",
  setupSteps: [],
};

function statusOf(overrides: Partial<CalendarAccountStatus> = {}): CalendarAccountStatus {
  return {
    available: true,
    state: 'not_connected',
    email: null,
    username: null,
    calendarUrl: null,
    providerKey: 'fastmail',
    providers: [GOOGLE, FASTMAIL, GMX, WEBDE, OTHER],
    ...overrides,
  };
}

function makePort(status: CalendarAccountStatus) {
  const port: CalendarSetupPort = {
    getCalendarStatus: vi.fn(async () => status),
    saveCalendarAccount: vi.fn(async () => statusOf({ state: 'connected', email: 'owner@example.invalid' })),
    removeCalendarAccount: vi.fn(async () => statusOf()),
  };
  return port;
}

function renderPanel(port: CalendarSetupPort) {
  return render(<CalendarSetupPanel open onOpenChange={() => undefined} port={port} onChanged={() => undefined} />);
}

describe('CalendarSetupPanel', () => {
  it('offers the providers, shows the built-in address, and connects with the typed password only', async () => {
    const port = makePort(statusOf());
    renderPanel(port);
    const select = await screen.findByLabelText(/calendar provider/i);
    expect([...select.querySelectorAll('option')].map(option => option.textContent)).toEqual([
      'Google',
      'Fastmail',
      'GMX',
      'web.de',
      'Other',
    ]);
    expect(screen.getByText(/Calendar address: https:\/\/caldav\.fastmail\.com\/dav\//)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'owner@example.invalid' } });
    fireEvent.change(screen.getByLabelText(/app password/i), { target: { value: CANARY } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(port.saveCalendarAccount).toHaveBeenCalled());
    expect(vi.mocked(port.saveCalendarAccount).mock.calls[0]?.[0]).toEqual({
      providerKey: 'fastmail',
      email: 'owner@example.invalid',
      password: CANARY,
    });
    // After the answer the form is gone and the password is nowhere on the page.
    expect(await screen.findByText(/Connected as/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(CANARY);
  });

  it('shows the Google steps, says the address comes from the email, and saves Google with no typed address', async () => {
    const port = makePort(statusOf({ providerKey: 'google' }));
    renderPanel(port);
    const select = await screen.findByLabelText(/calendar provider/i);
    expect(select).toHaveValue('google');
    expect(screen.getByText('Before you start')).toBeTruthy();
    for (const step of GOOGLE.setupSteps) {
      expect(screen.getByText(step)).toBeTruthy();
    }
    expect(screen.getByText(/Calendar address: filled in from your email address/)).toBeTruthy();

    fireEvent.change(select, { target: { value: 'fastmail' } });
    expect(screen.queryByText('Before you start')).toBeNull();
    fireEvent.change(select, { target: { value: 'google' } });
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'person@gmail.com' } });
    fireEvent.change(screen.getByLabelText(/app password/i), { target: { value: CANARY } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(port.saveCalendarAccount).toHaveBeenCalled());
    expect(vi.mocked(port.saveCalendarAccount).mock.calls[0]?.[0]).toEqual({
      providerKey: 'google',
      email: 'person@gmail.com',
      password: CANARY,
    });
  });

  it('shows the provider hint and a new-tab help link under the app password field', async () => {
    renderPanel(makePort(statusOf()));
    await screen.findByLabelText(/calendar provider/i);
    expect(
      screen.getByText(/An app password is a separate password for apps like this one, not your usual password\./),
    ).toBeTruthy();
    expect(screen.getByText(/Fastmail: make an app password under Settings/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'How to make an app password' });
    expect(link.getAttribute('href')).toBe(FASTMAIL.helpUrl);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    // The hint and the link sit below the field, in the same block.
    const field = screen.getByLabelText(/app password/i);
    expect(field.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('web.de shows its hint with no link, and Other says to ask the provider and asks for the address', async () => {
    const port = makePort(statusOf());
    renderPanel(port);
    const select = await screen.findByLabelText(/calendar provider/i);
    fireEvent.change(select, { target: { value: 'webde' } });
    expect(screen.getByText(/web\.de: make an application-specific password/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /how to make an app password/i })).toBeNull();

    fireEvent.change(select, { target: { value: 'other' } });
    expect(screen.getByText("Your calendar provider's help pages explain how to make an app password.")).toBeTruthy();
    expect(screen.queryByRole('link', { name: /how to make an app password/i })).toBeNull();
    expect(screen.getByText(/separate password for apps like this one/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/calendar address/i), {
      target: { value: ' https://nas.example.invalid/dav/ ' },
    });
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'owner@example.invalid' } });
    fireEvent.change(screen.getByLabelText(/login name/i), { target: { value: 'owner-login' } });
    fireEvent.change(screen.getByLabelText(/app password/i), { target: { value: CANARY } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(port.saveCalendarAccount).toHaveBeenCalled());
    expect(vi.mocked(port.saveCalendarAccount).mock.calls[0]?.[0]).toEqual({
      providerKey: 'other',
      email: 'owner@example.invalid',
      password: CANARY,
      username: 'owner-login',
      calendarUrl: 'https://nas.example.invalid/dav/',
    });
  });

  it('a refused sign-in shows the plain line and clears the password field', async () => {
    const port = makePort(statusOf());
    vi.mocked(port.saveCalendarAccount).mockRejectedValue(
      new Error('That login was refused. Make a new app password and try again.'),
    );
    renderPanel(port);
    await screen.findByLabelText(/calendar provider/i);
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'owner@example.invalid' } });
    const passwordField = screen.getByLabelText(/app password/i);
    fireEvent.change(passwordField, { target: { value: CANARY } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That login was refused. Make a new app password and try again.',
    );
    expect(passwordField).toHaveValue('');
  });

  it('shows the stopped line when the saved sign-in no longer works', async () => {
    renderPanel(makePort(statusOf({ state: 'sign_in_stopped', email: 'owner@example.invalid' })));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign-in stopped working. Make a new app password and save it again.',
    );
  });

  it('remove takes two steps and calls the port once confirmed', async () => {
    const port = makePort(statusOf({ state: 'connected', email: 'owner@example.invalid' }));
    renderPanel(port);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/deleted for good/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove calendar' }));
    await waitFor(() => expect(port.removeCalendarAccount).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText(/calendar provider/i)).toBeTruthy();
  });

  it('opens a saved Other account with its address and login filled in, and a change keeps the login', async () => {
    const port = makePort(
      statusOf({
        state: 'connected',
        email: 'owner@example.invalid',
        username: 'owner-login',
        calendarUrl: 'https://nas.example.invalid/dav/',
        providerKey: 'other',
      }),
    );
    renderPanel(port);
    fireEvent.click(await screen.findByRole('button', { name: 'Change calendar' }));
    expect(screen.getByLabelText(/calendar address/i)).toHaveValue('https://nas.example.invalid/dav/');
    expect(screen.getByLabelText(/login name/i)).toHaveValue('owner-login');
    expect(screen.getByLabelText(/email address/i)).toHaveValue('owner@example.invalid');
    expect(screen.getByLabelText(/app password/i)).toHaveValue('');

    fireEvent.change(screen.getByLabelText(/app password/i), { target: { value: CANARY } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(port.saveCalendarAccount).toHaveBeenCalled());
    expect(vi.mocked(port.saveCalendarAccount).mock.calls[0]?.[0]).toEqual({
      providerKey: 'other',
      email: 'owner@example.invalid',
      password: CANARY,
      username: 'owner-login',
      calendarUrl: 'https://nas.example.invalid/dav/',
    });
  });

  it('leaves the login box empty when the login is the email address', async () => {
    renderPanel(
      makePort(
        statusOf({
          state: 'connected',
          email: 'owner@example.invalid',
          username: 'owner@example.invalid',
          calendarUrl: 'https://caldav.fastmail.com/dav/',
        }),
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Change calendar' }));
    expect(screen.getByLabelText(/login name/i)).toHaveValue('');
  });

  it('after Remove the form starts again from nothing: no old login, address or email', async () => {
    const port = makePort(
      statusOf({
        state: 'connected',
        email: 'owner@example.invalid',
        username: 'owner-login',
        calendarUrl: 'https://nas.example.invalid/dav/',
        providerKey: 'other',
      }),
    );
    renderPanel(port);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove calendar' }));
    const provider = await screen.findByLabelText(/calendar provider/i);
    expect(provider).toHaveValue('fastmail');
    expect(screen.getByLabelText(/email address/i)).toHaveValue('');
    expect(screen.getByLabelText(/login name/i)).toHaveValue('');
    fireEvent.change(provider, { target: { value: 'other' } });
    expect(screen.getByLabelText(/calendar address/i)).toHaveValue('');
  });

  it.each([
    ['sign_in_stopped', /Sign-in stopped working/],
    ['not_working', /not working right now/],
  ] as const)('a %s account can still be removed, or the window closed', async (state, line) => {
    const onOpenChange = vi.fn();
    const port = makePort(statusOf({ state, email: 'owner@example.invalid' }));
    render(<CalendarSetupPanel open onOpenChange={onOpenChange} port={port} onChanged={() => undefined} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(line);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove calendar' }));
    await waitFor(() => expect(port.removeCalendarAccount).toHaveBeenCalledTimes(1));
  });

  it('a connected account being changed can go back with Cancel, and still be removed from the form', async () => {
    renderPanel(makePort(statusOf({ state: 'connected', email: 'owner@example.invalid' })));
    fireEvent.click(await screen.findByRole('button', { name: 'Change calendar' }));
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText(/Connected as/)).toBeTruthy();
  });

  it('asks the list to refresh when a save fails, since a cut-off save may still have gone through', async () => {
    const onChanged = vi.fn();
    const port = makePort(statusOf());
    vi.mocked(port.saveCalendarAccount).mockRejectedValue(
      new Error("Couldn't reach the calendar connector. Try again."),
    );
    render(<CalendarSetupPanel open onOpenChange={() => undefined} port={port} onChanged={onChanged} />);
    await screen.findByLabelText(/calendar provider/i);
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'owner@example.invalid' } });
    fireEvent.change(screen.getByLabelText(/app password/i), { target: { value: CANARY } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('alert');
    expect(onChanged).toHaveBeenCalled();
  });

  it('says so when the status cannot be read', async () => {
    const port = makePort(statusOf());
    vi.mocked(port.getCalendarStatus).mockRejectedValue(new Error("Couldn't reach the calendar connector. Try again."));
    renderPanel(port);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the calendar connector. Try again.");
  });
});
