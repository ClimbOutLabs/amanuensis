'use client';

import { useEffect, useState } from 'react';

import { useOptionalCatalogServer } from '../server/ServerContext.js';
import { hasCalendarSetup } from '../server/calendarSetup.js';
import { hasEmailSetup } from '../server/emailSetup.js';

/** Whether an email account and a calendar account are connected with an app password. */
export type ConnectedAccounts = { email: boolean; calendar: boolean };

const NONE: ConnectedAccounts = { email: false, calendar: false };

/**
 * The accounts connected in Settings, Connectors, Email and Calendar. Both read "no" while the
 * read is in flight, when it fails, or when the host has no such port, so callers only offer
 * what is known to work.
 */
export function useConnectedAccounts(): ConnectedAccounts {
  const connectors = useOptionalCatalogServer()?.connectorCatalog ?? null;
  const [connected, setConnected] = useState<ConnectedAccounts>(NONE);

  useEffect(() => {
    if (connectors === null) return;
    const state = { cancelled: false };
    const email = hasEmailSetup(connectors)
      ? connectors.getEmailStatus().then(status => status.available && status.state === 'connected')
      : Promise.resolve(false);
    const calendar = hasCalendarSetup(connectors)
      ? connectors.getCalendarStatus().then(status => status.available && status.state === 'connected')
      : Promise.resolve(false);
    // Each read stands alone: a failed email read must not hide a connected calendar.
    void Promise.all([email.catch(() => false), calendar.catch(() => false)]).then(([emailOn, calendarOn]) => {
      if (!state.cancelled) setConnected({ email: emailOn, calendar: calendarOn });
    });
    return () => {
      state.cancelled = true;
    };
  }, [connectors]);

  return connected;
}
