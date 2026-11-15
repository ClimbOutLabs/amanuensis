// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import EmailSetupPanel from '@/containers/SettingsBuilder/EmailSetupPanel.js';
import GoogleSetupPanel from '@/containers/SettingsBuilder/GoogleSetupPanel.js';
import type { EmailSetupPort } from '@/server/emailSetup.js';
import type { GoogleSetupPort } from '@/server/googleSetup.js';

// Whether this instance has Reach me at all, and the shell a button can steer.
let deliveries: object | null = {};
let shell: { setSettingsOpen: ReturnType<typeof vi.fn> } | null = null;

vi.mock('@/deliveries/DeliveriesContext.js', async importOriginal => ({
  ...(await importOriginal<typeof import('@/deliveries/DeliveriesContext.js')>()),
  useOptionalDeliveries: () => deliveries,
}));

vi.mock('@/server/ShellModeContext.js', async importOriginal => ({
  ...(await importOriginal<typeof import('@/server/ShellModeContext.js')>()),
  useOptionalShellMode: () => shell,
}));

// jsdom does not implement <dialog>.showModal()/close(); CenteredModal calls both.
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeEach(() => {
  deliveries = {};
  shell = null;
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

const emailPort: EmailSetupPort = {
  getEmailStatus: async () => ({
    available: true,
    state: 'connected',
    address: 'person@example.com',
    providerKey: 'gmail',
    accounts: [
      {
        address: 'person@example.com',
        providerKey: 'gmail',
        state: 'connected',
        isDefault: true,
        imapHost: 'imap.gmail.com',
        imapPort: 993,
        imapMode: 'ssl',
        smtpHost: 'smtp.gmail.com',
        smtpPort: 465,
        smtpMode: 'ssl',
      },
    ],
    defaultAddress: 'person@example.com',
    providers: [],
  }),
  saveEmailAccount: async () => {
    throw new Error('not used');
  },
  removeEmailAccount: async () => {
    throw new Error('not used');
  },
  setDefaultEmailAccount: async () => {
    throw new Error('not used');
  },
};

const googlePort: GoogleSetupPort = {
  getGoogleStatus: async () => ({
    state: 'not_connected',
    accountEmail: null,
    features: [{ feature: 'gmail_read', label: 'Read and search your email', granted: false }],
    hasSavedClient: false,
    locked: false,
    setup: { mode: 'paste', clientType: 'desktop', redirectUri: 'http://127.0.0.1:53682/callback' },
  }),
  checkGoogleClient: async () => ({ ok: true, problems: [] }),
  beginGoogleConsent: async () => {
    throw new Error('not used');
  },
  completeGoogleConsent: async () => {
    throw new Error('not used');
  },
  testGoogleConnection: async () => ({ result: 'ok', accountEmail: 'ada@example.com' }),
  disconnectGoogle: async () => ({ revocationConfirmed: true }),
};

const PANELS = [
  {
    name: 'Email',
    show: (onOpenChange: (open: boolean) => void) =>
      render(<EmailSetupPanel open onOpenChange={onOpenChange} port={emailPort} onChanged={() => undefined} />),
  },
  {
    name: 'Google',
    show: (onOpenChange: (open: boolean) => void) =>
      render(<GoogleSetupPanel open onOpenChange={onOpenChange} port={googlePort} onChanged={() => undefined} />),
  },
];

describe.each(PANELS)('the $name setup panel', ({ show }) => {
  it('says the assistant can watch mail, that this is off until turned on, and where the switch is', async () => {
    show(() => undefined);

    const note = await screen.findByTestId('watch-mail-note');
    expect(note.textContent).toContain('Aman can watch your mail for you');
    expect(note.textContent).toContain('bills that are due soon');
    expect(note.textContent).toContain('people you mark always important');
    expect(note.textContent).toContain('This is off until you turn it on, in Settings, Reach me.');
    // Outside the app shell there is nowhere to send a button, so the words alone say where to go.
    expect(screen.queryByRole('button', { name: 'Open Reach me' })).toBeNull();
  });

  it('opens Reach me and closes the panel from the button', async () => {
    shell = { setSettingsOpen: vi.fn() };
    const onOpenChange = vi.fn();
    show(onOpenChange);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Reach me' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(shell.setSettingsOpen).toHaveBeenCalledWith(true, 'reach-me');
  });

  it('says nothing where this instance has no Reach me', async () => {
    deliveries = null;
    show(() => undefined);

    await screen.findByRole('dialog');
    expect(screen.queryByTestId('watch-mail-note')).toBeNull();
  });
});
