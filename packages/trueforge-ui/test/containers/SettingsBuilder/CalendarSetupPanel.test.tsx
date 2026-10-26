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

const FASTMAIL: CalendarProviderInfo = {
  key: 'fastmail',
  name: 'Fastmail',
  serverUrl: 'https://caldav.fastmail.com/dav/',
  helpUrl: 'https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords',
  helpHint: 'Fastmail: make an app password under Settings, Privacy & Security.',
};

const GMX: CalendarProviderInfo = {
  key: 'gmx',
  name: 'GMX',
  serverUrl: null,
  helpUrl: 'https://support.gmx.com/security/2fa/application-specific-passwords.html',
  helpHint: 'GMX: make an application-specific password.',
};

const WEBDE: CalendarProviderInfo = {
  key: 'webde',
  name: 'web.de',
  serverUrl: 'https://caldav.web.de',
  helpUrl: null,
  helpHint: 'web.de: make an application-specific password.',
};

const OTHER: CalendarProviderInfo = {
  key: 'other',
  name: 'Other',
  serverUrl: null,
  helpUrl: null,
  helpHint: "Your calendar provider's help pages explain how to make an app password.",
};

function statusOf(overrides: Partial<CalendarAccountStatus> = {}): CalendarAccountStatus {
  return {
    available: true,
    state: 'not_connected',
    email: null,
    providerKey: 'fastmail',
    providers: [FASTMAIL, GMX, WEBDE, OTHER],
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
    expect((passwordField as HTMLInputElement).value).toBe('');
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

  it('says so when the status cannot be read', async () => {
    const port = makePort(statusOf());
    vi.mocked(port.getCalendarStatus).mockRejectedValue(new Error("Couldn't reach the calendar connector. Try again."));
    renderPanel(port);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the calendar connector. Try again.");
  });
});
