'use client';

import { useCallback, useState } from 'react';

import { CALDAV_GOOGLE_PROVIDER_KEY } from '@truefoundry/trueforge-core/core/calendar/caldav/presets';

import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import type { CalendarAccountStatus, CalendarSetupPort } from '@/server/calendarSetup.js';
import AccountSetupPanel from './AccountSetupPanel.js';

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

  // Every status, including the one after Remove, sets the whole form, so nothing stale is left behind.
  const applyStatus = useCallback((next: CalendarAccountStatus) => {
    setProviderKey(next.providerKey);
    setEmail(next.email ?? '');
    // The login only needs its own box when it is not the email address.
    setUsername(next.username !== null && next.username !== next.email ? next.username : '');
    setCalendarUrl(next.providerKey === OTHER_KEY ? (next.calendarUrl ?? '') : '');
    setPassword('');
  }, []);
  const clearPassword = useCallback(() => setPassword(''), []);
  const loadStatus = useCallback(() => port.getCalendarStatus(), [port]);
  const removeAccount = useCallback(() => port.removeCalendarAccount(), [port]);

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
      description="Connect your calendar with an app password, so your assistant can look at your calendar and, with your approval, add and change events."
      thing="calendar"
      connector="calendar connector"
      loadStatus={loadStatus}
      saveAccount={saveAccount}
      removeAccount={removeAccount}
      onOpened={clearPassword}
      onStatus={applyStatus}
      connectedAs={status => status.email}
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
