'use client';

import { useCallback, useRef, useState } from 'react';

import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { WatchMailNote } from '@/deliveries/WatchMailNote.js';
import type { EmailAccountStatus, EmailProviderInfo, EmailSetupPort } from '@/server/emailSetup.js';
import AccountSetupPanel, { type PanelAccount } from './AccountSetupPanel.js';

type EmailSetupPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  port: EmailSetupPort;
  /** Called after anything that changes the connection, so the list can refresh. */
  onChanged: () => void;
};

const OTHER_PROVIDER: EmailProviderInfo = {
  key: 'other',
  name: 'Other',
  imapHost: '',
  imapPort: 993,
  imapMode: 'ssl',
  smtpHost: '',
  smtpPort: 465,
  smtpMode: 'ssl',
  helpUrl: null,
  helpHint: '',
};

const LABEL_CLASS = 'mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary';

const DEFAULT_PORTS = { imapPort: '993', smtpPort: '465' };

/**
 * The Email card's setup panel: the provider fields on the shared panel. The app password is typed here and
 * nowhere else: it goes straight to the server endpoint, is cleared from this form on every answer, and is
 * never shown back.
 */
export default function EmailSetupPanel({ open, onOpenChange, port, onChanged }: EmailSetupPanelProps) {
  const [providerKey, setProviderKey] = useState('gmail');
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState(DEFAULT_PORTS.imapPort);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(DEFAULT_PORTS.smtpPort);
  /** The saved account the form is changing; null while the form is for a new account. */
  const [editingAddress, setEditingAddress] = useState<string | null>(null);
  const statusRef = useRef<EmailAccountStatus | null>(null);
  const editingRef = useRef<string | null>(null);

  const fillForm = useCallback((status: EmailAccountStatus, forAddress: string | null) => {
    const entry =
      forAddress === null
        ? (status.accounts.find(account => account.isDefault) ?? status.accounts[0])
        : status.accounts.find(account => account.address === forAddress);
    setProviderKey(entry?.providerKey ?? status.providerKey);
    setAddress(entry?.address ?? '');
    setPassword('');
    if (entry !== undefined && entry.providerKey === 'other') {
      setImapHost(entry.imapHost);
      setImapPort(String(entry.imapPort));
      setSmtpHost(entry.smtpHost);
      setSmtpPort(String(entry.smtpPort));
    } else {
      setImapHost('');
      setImapPort(DEFAULT_PORTS.imapPort);
      setSmtpHost('');
      setSmtpPort(DEFAULT_PORTS.smtpPort);
    }
  }, []);

  const clearForm = useCallback((status: EmailAccountStatus | null) => {
    setProviderKey(status?.providerKey ?? 'gmail');
    setAddress('');
    setPassword('');
    setImapHost('');
    setImapPort(DEFAULT_PORTS.imapPort);
    setSmtpHost('');
    setSmtpPort(DEFAULT_PORTS.smtpPort);
  }, []);

  // Every status, including the one after Remove, sets the whole form, so nothing stale is left behind.
  const applyStatus = useCallback(
    (next: EmailAccountStatus) => {
      statusRef.current = next;
      const editing = editingRef.current;
      if (editing !== null && !next.accounts.some(account => account.address === editing)) {
        editingRef.current = null;
        setEditingAddress(null);
        fillForm(next, null);
        return;
      }
      fillForm(next, editing);
    },
    [fillForm],
  );
  const clearPassword = useCallback(() => setPassword(''), []);
  const loadStatus = useCallback(() => port.getEmailStatus(), [port]);
  const removeAccount = useCallback(async () => {
    const status = statusRef.current;
    const target = editingRef.current ?? status?.defaultAddress ?? null;
    if (status === null || target === null) {
      return port.getEmailStatus();
    }
    return port.removeEmailAccount(target);
  }, [port]);

  const listAccounts = useCallback(
    (status: EmailAccountStatus): readonly PanelAccount[] =>
      status.accounts.map(account => ({
        key: account.address,
        label: account.address,
        state: account.state,
        isDefault: account.isDefault,
      })),
    [],
  );
  const beginEdit = useCallback(
    (key: string | null) => {
      editingRef.current = key;
      setEditingAddress(key);
      if (key === null) {
        clearForm(statusRef.current);
      } else if (statusRef.current !== null) {
        fillForm(statusRef.current, key);
      }
    },
    [clearForm, fillForm],
  );
  const makeDefault = useCallback((key: string) => port.setDefaultEmailAccount(key), [port]);
  const removeOne = useCallback((key: string) => port.removeEmailAccount(key), [port]);
  const saveNote =
    editingAddress !== null
      ? 'Saving replaces the saved details for this account. The sign-in is checked before anything is saved.'
      : 'The sign-in is checked before anything is saved. Connecting an account keeps the accounts already connected.';

  const isOther = providerKey === 'other';
  const saveAccount = async () => {
    try {
      return await port.saveEmailAccount({
        providerKey,
        address: address.trim(),
        password,
        ...(isOther
          ? {
              imapHost: imapHost.trim(),
              imapPort: Number(imapPort),
              smtpHost: smtpHost.trim(),
              smtpPort: Number(smtpPort),
            }
          : {}),
      });
    } finally {
      setPassword('');
    }
  };

  return (
    <AccountSetupPanel
      open={open}
      onOpenChange={onOpenChange}
      onChanged={onChanged}
      title="Email"
      description="Connect email accounts with app passwords, so your assistant can read your email and, with your approval, draft and send it."
      thing="account"
      connector="email connector"
      loadStatus={loadStatus}
      saveAccount={saveAccount}
      removeAccount={removeAccount}
      onOpened={clearPassword}
      onStatus={applyStatus}
      connectedAs={status => status.address}
      listAccounts={listAccounts}
      beginEdit={beginEdit}
      makeDefault={makeDefault}
      removeOne={removeOne}
      saveNote={saveNote}
      canSubmit={address.trim() !== '' && password !== ''}
      note={<WatchMailNote onOpenReachMe={() => onOpenChange(false)} />}
      fields={status => {
        const providers = [...status.providers, OTHER_PROVIDER];
        const provider = providers.find(item => item.key === providerKey) ?? OTHER_PROVIDER;
        return (
          <>
            <div>
              <label htmlFor="email-provider" className={LABEL_CLASS}>
                Email provider
              </label>
              <select
                id="email-provider"
                value={providerKey}
                onChange={event => setProviderKey(event.target.value)}
                className={auiInputClass('h-11')}
              >
                {providers.map(item => (
                  <option key={item.key} value={item.key}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            {!isOther ? (
              <p className="text-text-secondary">
                Incoming server {provider.imapHost} (port {provider.imapPort}), outgoing server {provider.smtpHost}{' '}
                (port {provider.smtpPort}).
              </p>
            ) : null}
            {provider.helpHint !== '' ? (
              <p className="text-text-secondary">
                {provider.helpHint}{' '}
                {provider.helpUrl !== null ? (
                  <a href={provider.helpUrl} target="_blank" rel="noopener noreferrer" className="text-link underline">
                    How to get an app password
                  </a>
                ) : null}
              </p>
            ) : null}
            <div>
              <label htmlFor="email-address" className={LABEL_CLASS}>
                Email address
              </label>
              <input
                id="email-address"
                type="email"
                value={address}
                onChange={event => setAddress(event.target.value)}
                autoComplete="email"
                required
                className={auiInputClass('h-11')}
              />
            </div>
            <div>
              <label htmlFor="email-app-password" className={LABEL_CLASS}>
                App password
              </label>
              <input
                id="email-app-password"
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                autoComplete="off"
                required
                className={auiInputClass('h-11')}
              />
              <p className="mt-1 text-text-secondary">
                An app password is a separate password for apps like this one, not your usual password.
              </p>
            </div>
            {isOther ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="email-imap-host" className={LABEL_CLASS}>
                    Incoming server (IMAP)
                  </label>
                  <input
                    id="email-imap-host"
                    type="text"
                    value={imapHost}
                    onChange={event => setImapHost(event.target.value)}
                    required
                    className={auiInputClass('h-11')}
                  />
                </div>
                <div>
                  <label htmlFor="email-imap-port" className={LABEL_CLASS}>
                    Incoming port
                  </label>
                  <input
                    id="email-imap-port"
                    type="number"
                    value={imapPort}
                    onChange={event => setImapPort(event.target.value)}
                    required
                    className={auiInputClass('h-11')}
                  />
                </div>
                <div>
                  <label htmlFor="email-smtp-host" className={LABEL_CLASS}>
                    Outgoing server (SMTP)
                  </label>
                  <input
                    id="email-smtp-host"
                    type="text"
                    value={smtpHost}
                    onChange={event => setSmtpHost(event.target.value)}
                    required
                    className={auiInputClass('h-11')}
                  />
                </div>
                <div>
                  <label htmlFor="email-smtp-port" className={LABEL_CLASS}>
                    Outgoing port
                  </label>
                  <input
                    id="email-smtp-port"
                    type="number"
                    value={smtpPort}
                    onChange={event => setSmtpPort(event.target.value)}
                    required
                    className={auiInputClass('h-11')}
                  />
                </div>
              </div>
            ) : null}
          </>
        );
      }}
    />
  );
}
