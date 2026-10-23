// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import EmailSetupPanel from '@/containers/SettingsBuilder/EmailSetupPanel.js';
import type { EmailAccountStatus, EmailProviderInfo, EmailSetupPort } from '@/server/emailSetup.js';

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

const GMAIL: EmailProviderInfo = {
  key: 'gmail',
  name: 'Gmail',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  imapMode: 'ssl',
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
  smtpMode: 'ssl',
  helpUrl: 'https://support.google.com/accounts/answer/185833',
  helpHint: 'Turn on two-step verification, then make an app password for Mail.',
};

const WEBDE: EmailProviderInfo = {
  key: 'webde',
  name: 'web.de',
  imapHost: 'imap.web.de',
  imapPort: 993,
  imapMode: 'ssl',
  smtpHost: 'smtp.web.de',
  smtpPort: 587,
  smtpMode: 'starttls',
  helpUrl: null,
  helpHint: 'Turn on two-step verification, then make an app password for external email apps.',
};

function statusOf(overrides: Partial<EmailAccountStatus> = {}): EmailAccountStatus {
  return {
    available: true,
    state: 'not_connected',
    address: null,
    providerKey: 'gmail',
    providers: [GMAIL, WEBDE],
    ...overrides,
  };
}

function makePort(status: EmailAccountStatus) {
  const port: EmailSetupPort = {
    getEmailStatus: vi.fn(async () => status),
    saveEmailAccount: vi.fn(async () => statusOf({ state: 'connected', address: 'person@gmail.com' })),
    removeEmailAccount: vi.fn(async () => statusOf()),
  };
  return port;
}

function renderPanel(port: EmailSetupPort) {
  return render(<EmailSetupPanel open onOpenChange={() => undefined} port={port} onChanged={() => undefined} />);
}

describe('EmailSetupPanel', () => {
  it('offers the providers with the checked help link, and connects with the typed password only', async () => {
    const port = makePort(statusOf());
    renderPanel(port);
    const select = await screen.findByLabelText(/email provider/i);
    expect([...select.querySelectorAll('option')].map(option => option.textContent)).toEqual([
      'Gmail',
      'web.de',
      'Other',
    ]);
    const link = screen.getByRole('link', { name: /how to get an app password/i });
    expect(link.getAttribute('href')).toBe('https://support.google.com/accounts/answer/185833');

    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'person@gmail.com' } });
    fireEvent.change(screen.getByLabelText(/app password/i), { target: { value: CANARY } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(port.saveEmailAccount).toHaveBeenCalled());
    expect(vi.mocked(port.saveEmailAccount).mock.calls[0]?.[0]).toEqual({
      providerKey: 'gmail',
      address: 'person@gmail.com',
      password: CANARY,
    });
    // After the answer the form is gone and the password is nowhere on the page.
    expect(await screen.findByText(/Connected as/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(CANARY);
  });

  it('a refused sign-in shows the plain line and clears the password field', async () => {
    const port = makePort(statusOf());
    vi.mocked(port.saveEmailAccount).mockRejectedValue(
      new Error('That password was refused. Make a new app password and try again.'),
    );
    renderPanel(port);
    await screen.findByLabelText(/email provider/i);
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'person@gmail.com' } });
    const passwordField = screen.getByLabelText(/app password/i);
    fireEvent.change(passwordField, { target: { value: CANARY } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That password was refused. Make a new app password and try again.',
    );
    expect((passwordField as HTMLInputElement).value).toBe('');
  });

  it('shows the stopped line when the saved sign-in no longer works', async () => {
    const port = makePort(statusOf({ state: 'sign_in_stopped', address: 'person@gmail.com' }));
    renderPanel(port);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign-in stopped working. Make a new app password and save it again.',
    );
  });

  it('remove takes two steps and calls the port once confirmed', async () => {
    const port = makePort(statusOf({ state: 'connected', address: 'person@gmail.com' }));
    renderPanel(port);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/deleted for good/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }));
    await waitFor(() => expect(port.removeEmailAccount).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText(/email provider/i)).toBeTruthy();
  });

  it('Other shows the server fields, and web.de shows its hint with no link', async () => {
    const port = makePort(statusOf());
    renderPanel(port);
    const select = await screen.findByLabelText(/email provider/i);
    fireEvent.change(select, { target: { value: 'other' } });
    expect(screen.getByLabelText(/incoming server/i)).toBeTruthy();
    expect(screen.getByLabelText(/outgoing server/i)).toBeTruthy();
    fireEvent.change(select, { target: { value: 'webde' } });
    expect(screen.getByText(/app password for external email apps/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /how to get an app password/i })).toBeNull();
  });
});
