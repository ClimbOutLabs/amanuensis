'use client';

import { useCallback, useEffect, useState } from 'react';

import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { Button } from '@/atoms/primitives/Button.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import type { CalendarAccountStatus, CalendarSetupPort } from '@/server/calendarSetup.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';

type CalendarSetupPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  port: CalendarSetupPort;
  /** Called after anything that changes the connection, so the list can refresh. */
  onChanged: () => void;
};

const OTHER_KEY = 'other';
const STOPPED_LINE = 'Sign-in stopped working. Make a new app password and save it again.';
const LABEL_CLASS = 'mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary';

/**
 * The Calendar card's setup panel. The app password is typed here and nowhere else: it goes
 * straight to the server endpoint, is cleared from this form on every answer, and is never
 * shown back. The card and this panel only ever see the email address and the status.
 */
export default function CalendarSetupPanel({ open, onOpenChange, port, onChanged }: CalendarSetupPanelProps) {
  const [status, setStatus] = useState<CalendarAccountStatus | null>(null);
  const [providerKey, setProviderKey] = useState('fastmail');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [calendarUrl, setCalendarUrl] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback((next: CalendarAccountStatus) => {
    setStatus(next);
    setProviderKey(next.providerKey);
    setEmail(next.email ?? '');
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
      .getCalendarStatus()
      .then(next => {
        if (!cancelled) {
          applyStatus(next);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(getErrorMessage(caught, "Couldn't check your calendar just now. Try again."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, port, applyStatus]);

  const providers = status?.providers ?? [];
  const provider = providers.find(item => item.key === providerKey) ?? providers.find(item => item.key === OTHER_KEY);
  const isOther = providerKey === OTHER_KEY;
  const connected = status?.state === 'connected';

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmedLogin = username.trim();
      const next = await port.saveCalendarAccount({
        providerKey,
        email: email.trim(),
        password,
        ...(trimmedLogin === '' ? {} : { username: trimmedLogin }),
        ...(isOther ? { calendarUrl: calendarUrl.trim() } : {}),
      });
      setPassword('');
      applyStatus(next);
      onChanged();
    } catch (caught) {
      setPassword('');
      setError(getErrorMessage(caught, "Couldn't save that calendar. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await port.removeCalendarAccount();
      applyStatus(next);
      onChanged();
    } catch (caught) {
      setError(getErrorMessage(caught, "Couldn't remove that calendar. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CenteredModal
      open={open}
      onOpenChange={onOpenChange}
      title="Calendar"
      description="Connect a CalDAV calendar with an app password, so your assistant can look at your calendar and, with your approval, add and change events."
      className="md:max-w-2xl"
    >
      <div className="space-y-5 px-5 py-5 text-sm text-text-primary">
        {error ? (
          <p role="alert" className="rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-failure-bg">
            {error}
          </p>
        ) : null}

        {status === null && error === null ? <p className="text-text-secondary">Checking…</p> : null}

        {status !== null && connected && !showForm ? (
          <div className="space-y-4">
            <p>
              Connected as <span className="font-medium">{status.email}</span>.
            </p>
            <p className="text-text-secondary">
              The app password is saved only on this computer, in the calendar connector. It is never shown again.
            </p>
            {confirmingRemove ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="w-full text-text-secondary">
                  Remove this calendar? The saved app password is deleted for good.
                </p>
                <Button type="button" disabled={busy} onClick={() => void handleRemove()}>
                  Remove calendar
                </Button>
                <Button variant="ghost" type="button" disabled={busy} onClick={() => setConfirmingRemove(false)}>
                  Keep it
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" type="button" onClick={() => setShowForm(true)}>
                  Change calendar
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
                Saving replaces the connected calendar. The sign-in is checked before anything is saved.
              </p>
            ) : (
              <p className="text-text-secondary">The sign-in is checked before anything is saved.</p>
            )}
            <div>
              <label htmlFor="calendar-provider" className={LABEL_CLASS}>
                Calendar provider
              </label>
              <select
                id="calendar-provider"
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
            {provider?.serverUrl ? <p className="text-text-secondary">Calendar address: {provider.serverUrl}</p> : null}
            {isOther ? (
              <div>
                <label htmlFor="calendar-url" className={LABEL_CLASS}>
                  Calendar address
                </label>
                <input
                  id="calendar-url"
                  type="text"
                  value={calendarUrl}
                  onChange={event => setCalendarUrl(event.target.value)}
                  placeholder="https://caldav.example.com/dav/"
                  autoComplete="off"
                  required
                  className={auiInputClass('h-11')}
                />
                <p className="mt-1 text-text-secondary">
                  It must start with https://. It can be on the internet or on your home or office network.
                </p>
              </div>
            ) : null}
            <div>
              <label htmlFor="calendar-email" className={LABEL_CLASS}>
                Email address
              </label>
              <input
                id="calendar-email"
                type="email"
                value={email}
                onChange={event => setEmail(event.target.value)}
                autoComplete="email"
                required
                className={auiInputClass('h-11')}
              />
            </div>
            <div>
              <label htmlFor="calendar-login" className={LABEL_CLASS}>
                Login name, only if it differs from your email
              </label>
              <input
                id="calendar-login"
                type="text"
                value={username}
                onChange={event => setUsername(event.target.value)}
                autoComplete="off"
                className={auiInputClass('h-11')}
              />
            </div>
            <div>
              <label htmlFor="calendar-app-password" className={LABEL_CLASS}>
                App password
              </label>
              <input
                id="calendar-app-password"
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
              {provider !== undefined && provider.helpHint !== '' ? (
                <p className="mt-1 text-text-secondary">
                  {provider.helpHint}{' '}
                  {provider.helpUrl !== null ? (
                    <a
                      href={provider.helpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-link underline"
                    >
                      How to make an app password
                    </a>
                  ) : null}
                </p>
              ) : null}
            </div>
            <div className="flex justify-end gap-2">
              {connected ? (
                <Button variant="ghost" type="button" disabled={busy} onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              ) : null}
              <Button type="submit" disabled={busy || email.trim() === '' || password === ''}>
                {busy ? 'Checking…' : 'Connect'}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </CenteredModal>
  );
}
