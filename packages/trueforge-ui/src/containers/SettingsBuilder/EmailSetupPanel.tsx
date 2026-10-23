'use client';

import { useCallback, useEffect, useState } from 'react';

import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { Button } from '@/atoms/primitives/Button.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import type { EmailAccountStatus, EmailProviderInfo, EmailSetupPort } from '@/server/emailSetup.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';

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

const STOPPED_LINE = 'Sign-in stopped working. Make a new app password and save it again.';

/**
 * The Email card's setup panel. The app password is typed here and nowhere else: it goes
 * straight to the server endpoint, is cleared from this form on every answer, and is never
 * shown back. The card and this panel only ever see the address and the status.
 */
export default function EmailSetupPanel({ open, onOpenChange, port, onChanged }: EmailSetupPanelProps) {
  const [status, setStatus] = useState<EmailAccountStatus | null>(null);
  const [providerKey, setProviderKey] = useState('gmail');
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('993');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('465');
  const [showForm, setShowForm] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback((next: EmailAccountStatus) => {
    setStatus(next);
    setProviderKey(next.providerKey);
    setAddress(next.address ?? '');
    setShowForm(next.state !== 'connected');
    setConfirmingRemove(false);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setPassword('');
    let cancelled = false;
    void port
      .getEmailStatus()
      .then(next => {
        if (!cancelled) {
          applyStatus(next);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(getErrorMessage(caught, "Couldn't check your email account just now. Try again."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, port, applyStatus]);

  const providers = [...(status?.providers ?? []), OTHER_PROVIDER];
  const provider = providers.find(item => item.key === providerKey) ?? OTHER_PROVIDER;
  const isOther = provider.key === 'other';
  const connected = status?.state === 'connected';

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await port.saveEmailAccount({
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
      setPassword('');
      applyStatus(next);
      onChanged();
    } catch (caught) {
      setPassword('');
      setError(getErrorMessage(caught, "Couldn't save that account. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await port.removeEmailAccount();
      applyStatus(next);
      onChanged();
    } catch (caught) {
      setError(getErrorMessage(caught, "Couldn't remove that account. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CenteredModal
      open={open}
      onOpenChange={onOpenChange}
      title="Email"
      description="Connect an email account with an app password, so your assistant can read your email and, with your approval, draft and send it."
      className="md:max-w-2xl"
    >
      <div className="space-y-5 px-5 py-5 text-sm text-text-primary">
        {error ? (
          <p role="alert" className="rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-failure-bg">
            {error}
          </p>
        ) : null}

        {status === null ? <p className="text-text-secondary">Checking…</p> : null}

        {status !== null && connected && !showForm ? (
          <div className="space-y-4">
            <p>
              Connected as <span className="font-medium">{status.address}</span>.
            </p>
            <p className="text-text-secondary">
              The app password is saved only on this computer, in the email connector. It is never shown again.
            </p>
            {confirmingRemove ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="w-full text-text-secondary">
                  Remove this account? The saved app password is deleted for good.
                </p>
                <Button type="button" disabled={busy} onClick={() => void handleRemove()}>
                  Remove account
                </Button>
                <Button variant="ghost" type="button" disabled={busy} onClick={() => setConfirmingRemove(false)}>
                  Keep it
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" type="button" onClick={() => setShowForm(true)}>
                  Change account
                </Button>
                <Button variant="ghost" type="button" onClick={() => setConfirmingRemove(true)}>
                  Remove
                </Button>
              </div>
            )}
          </div>
        ) : null}

        {status !== null && (!connected || showForm) ? (
          <form onSubmit={event => void handleSave(event)} className="space-y-4">
            {status.state === 'sign_in_stopped' ? (
              <p
                role="alert"
                className="rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-failure-bg"
              >
                {STOPPED_LINE}
              </p>
            ) : null}
            {connected ? (
              <p className="text-text-secondary">
                Saving replaces the connected account. The sign-in is checked before anything is saved.
              </p>
            ) : (
              <p className="text-text-secondary">The sign-in is checked before anything is saved.</p>
            )}
            <div>
              <label
                htmlFor="email-provider"
                className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary"
              >
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
              <label
                htmlFor="email-address"
                className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary"
              >
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
              <label
                htmlFor="email-app-password"
                className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary"
              >
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
                  <label
                    htmlFor="email-imap-host"
                    className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary"
                  >
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
                  <label
                    htmlFor="email-imap-port"
                    className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary"
                  >
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
                  <label
                    htmlFor="email-smtp-host"
                    className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary"
                  >
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
                  <label
                    htmlFor="email-smtp-port"
                    className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary"
                  >
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
            <div className="flex justify-end gap-2">
              {connected ? (
                <Button variant="ghost" type="button" disabled={busy} onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              ) : null}
              <Button type="submit" disabled={busy || address.trim() === '' || password === ''}>
                {busy ? 'Checking…' : 'Connect'}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </CenteredModal>
  );
}
