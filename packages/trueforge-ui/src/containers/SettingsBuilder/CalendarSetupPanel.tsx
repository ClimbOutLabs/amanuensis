'use client';

import { useCallback, useRef, useState } from 'react';

import { CALDAV_GOOGLE_PROVIDER_KEY } from '@truefoundry/trueforge-core/core/calendar/caldav/presets';

import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import type { CalendarAccountStatus, CalendarSetupPort } from '@/server/calendarSetup.js';
import AccountSetupPanel, { type PanelAccount } from './AccountSetupPanel.js';

type CalendarSetupPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  port: CalendarSetupPort;
  /** Called after anything that changes the connection, so the list can refresh. */
  onChanged: () => void;
};

const OTHER_KEY = 'other';
const LABEL_CLASS = 'mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary';

/**
 * The Calendar card's setup panel: the provider fields on the shared panel. The app password is typed here
 * and nowhere else: it goes straight to the server endpoint, is cleared from this form on every answer, and
 * is never shown back. The saved address and login are put back in the form so a change keeps them.
 */
export default function CalendarSetupPanel({ open, onOpenChange, port, onChanged }: CalendarSetupPanelProps) {
  const [providerKey, setProviderKey] = useState(CALDAV_GOOGLE_PROVIDER_KEY);
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [calendarUrl, setCalendarUrl] = useState('');
  /** The saved account the form is changing; null while the form is for a new account. */
  const [editingAddress, setEditingAddress] = useState<string | null>(null);
  const statusRef = useRef<CalendarAccountStatus | null>(null);
  const editingRef = useRef<string | null>(null);

  const fillForm = useCallback((status: CalendarAccountStatus, forAddress: string | null) => {
    const entry =
      forAddress === null
        ? (status.accounts.find(account => account.isDefault) ?? status.accounts[0])
        : status.accounts.find(account => account.email === forAddress);
    setProviderKey(entry?.providerKey ?? status.providerKey);
    setEmail(entry?.email ?? '');
    // The login only needs its own box when it is not the email address.
    setUsername(entry !== undefined && entry.username !== entry.email ? entry.username : '');
    setCalendarUrl(entry !== undefined && entry.providerKey === OTHER_KEY ? entry.calendarUrl : '');
    setPassword('');
  }, []);

  const clearForm = useCallback((status: CalendarAccountStatus | null) => {
    setProviderKey(status?.providerKey ?? CALDAV_GOOGLE_PROVIDER_KEY);
    setEmail('');
    setUsername('');
    setCalendarUrl('');
    setPassword('');
  }, []);

  // Every status, including the one after Remove, sets the whole form, so nothing stale is left behind.
  const applyStatus = useCallback(
    (next: CalendarAccountStatus) => {
      statusRef.current = next;
      const editing = editingRef.current;
      if (editing !== null && !next.accounts.some(account => account.email === editing)) {
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
  const loadStatus = useCallback(() => port.getCalendarStatus(), [port]);
  const removeAccount = useCallback(async () => {
    const status = statusRef.current;
    const target = editingRef.current ?? status?.defaultAddress ?? null;
    if (status === null || target === null) {
      return port.getCalendarStatus();
    }
    return port.removeCalendarAccount(target);
  }, [port]);

  const listAccounts = useCallback(
    (status: CalendarAccountStatus): readonly PanelAccount[] =>
      status.accounts.map(account => ({
        key: account.email,
        label: account.email,
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
  const makeDefault = useCallback((key: string) => port.setDefaultCalendarAccount(key), [port]);
  const removeOne = useCallback((key: string) => port.removeCalendarAccount(key), [port]);
  const saveNote =
    editingAddress !== null
      ? 'Saving replaces the saved details for this account. The sign-in is checked before anything is saved.'
      : 'The sign-in is checked before anything is saved. Connecting an account keeps the accounts already connected.';

  const isOther = providerKey === OTHER_KEY;
  const saveAccount = async () => {
    try {
      const trimmedLogin = username.trim();
      return await port.saveCalendarAccount({
        providerKey,
        email: email.trim(),
        password,
        ...(trimmedLogin === '' ? {} : { username: trimmedLogin }),
        ...(isOther ? { calendarUrl: calendarUrl.trim() } : {}),
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
      title="Calendar"
      description="Connect calendar accounts with app passwords, so your assistant can look at your calendars and, with your approval, add and change events."
      thing="account"
      connector="calendar connector"
      loadStatus={loadStatus}
      saveAccount={saveAccount}
      removeAccount={removeAccount}
      onOpened={clearPassword}
      onStatus={applyStatus}
      connectedAs={status => status.email}
      listAccounts={listAccounts}
      beginEdit={beginEdit}
      makeDefault={makeDefault}
      removeOne={removeOne}
      saveNote={saveNote}
      canSubmit={email.trim() !== '' && password !== ''}
      fields={status => {
        const providers = status.providers;
        const provider =
          providers.find(item => item.key === providerKey) ?? providers.find(item => item.key === OTHER_KEY);
        return (
          <>
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
            {provider !== undefined && provider.setupSteps.length > 0 ? (
              <div>
                <p className={LABEL_CLASS}>Before you start</p>
                <ol className="list-decimal space-y-1 pl-5 text-text-secondary">
                  {provider.setupSteps.map(step => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>
            ) : null}
            {provider?.serverUrl ? <p className="text-text-secondary">Calendar address: {provider.serverUrl}</p> : null}
            {provider?.serverUrl == null && provider?.accountUrlTemplate ? (
              <p className="text-text-secondary">Calendar address: filled in from your email address</p>
            ) : null}
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
          </>
        );
      }}
    />
  );
}
