import { createLogger } from 'winston';

import type { PersonOwner } from '../../../src/db/personOwner';
import type { IReachSettingsStore } from '../../../src/db/reachSettingsStore';
import { turnTimezoneFor } from '../../../src/runtime/turnTimezone';
import { defaultReachSettings, type ReachSettings } from '../../../src/schemas/reach';

const OWNER: PersonOwner = { tenant_id: 'default', created_by: 'owner-1' };
const logger = createLogger({ silent: true });

/** Reach me settings kept in memory, with the same "add only when there are none" rule as the real store. */
function reachStore(saved?: ReachSettings) {
  let settings = saved;
  const get = jest.fn<ReturnType<IReachSettingsStore['get']>, Parameters<IReachSettingsStore['get']>>(() =>
    Promise.resolve(settings),
  );
  const importSettings = jest.fn<
    ReturnType<IReachSettingsStore['importSettings']>,
    Parameters<IReachSettingsStore['importSettings']>
  >(input => {
    if (settings !== undefined) {
      return Promise.resolve(false);
    }
    settings = input.settings;
    return Promise.resolve(true);
  });
  return { get, importSettings, current: () => settings };
}

describe('the time zone a turn reads the person’s day in', () => {
  it('uses the browser’s zone, and saves it to Reach me when the person has none there', async () => {
    const store = reachStore();
    const knownTimezone = jest.fn(() => Promise.resolve('Europe/Paris'));
    const zoneOf = turnTimezoneFor({ reachSettings: store, knownTimezone, logger });

    await expect(zoneOf({ owner: OWNER, clientTimezone: 'America/Los_Angeles' })).resolves.toBe('America/Los_Angeles');

    // Saved as the quiet defaults, so nothing starts checking or calling because of it.
    expect(store.current()).toEqual(defaultReachSettings('America/Los_Angeles'));
    expect(knownTimezone).not.toHaveBeenCalled();
  });

  it('never replaces a zone the person saved, and still uses the browser’s for that message', async () => {
    const store = reachStore(defaultReachSettings('Pacific/Auckland'));
    const zoneOf = turnTimezoneFor({ reachSettings: store, knownTimezone: () => Promise.resolve(undefined), logger });

    await expect(zoneOf({ owner: OWNER, clientTimezone: 'America/Los_Angeles' })).resolves.toBe('America/Los_Angeles');
    await expect(zoneOf({ owner: OWNER, clientTimezone: 'America/Los_Angeles' })).resolves.toBe('America/Los_Angeles');

    expect(store.current()?.timezone).toBe('Pacific/Auckland');
    expect(store.importSettings).not.toHaveBeenCalled();
    // Looked up once for this person, not on every message.
    expect(store.get).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, '', 'Not/A_Zone'])(
    'looks the zone up for a message that brings %p: Reach me first, then schedules or the calendar',
    async clientTimezone => {
      const knownTimezone = jest.fn(() => Promise.resolve<string | undefined>('Europe/Paris'));
      const saved = turnTimezoneFor({
        reachSettings: reachStore(defaultReachSettings('America/Los_Angeles')),
        knownTimezone,
        logger,
      });
      await expect(saved({ owner: OWNER, clientTimezone })).resolves.toBe('America/Los_Angeles');
      expect(knownTimezone).not.toHaveBeenCalled();

      const store = reachStore();
      const unsaved = turnTimezoneFor({ reachSettings: store, knownTimezone, logger });
      await expect(unsaved({ owner: OWNER, clientTimezone })).resolves.toBe('Europe/Paris');
      expect(knownTimezone).toHaveBeenCalledWith(OWNER);
      // A looked-up zone is not written to Reach me: only a browser says where the person is now.
      expect(store.importSettings).not.toHaveBeenCalled();
    },
  );

  it('says nothing is known when no browser, Reach me, schedule or calendar gives a zone', async () => {
    const zoneOf = turnTimezoneFor({
      reachSettings: reachStore(),
      knownTimezone: () => Promise.resolve(undefined),
      logger,
    });
    await expect(zoneOf({ owner: OWNER, clientTimezone: undefined })).resolves.toBeUndefined();
  });

  it('a message from Telegram after one from a browser gets the browser’s zone', async () => {
    const zoneOf = turnTimezoneFor({
      reachSettings: reachStore(),
      knownTimezone: () => Promise.resolve(undefined),
      logger,
    });
    await zoneOf({ owner: OWNER, clientTimezone: 'America/Los_Angeles' });
    await expect(zoneOf({ owner: OWNER, clientTimezone: undefined })).resolves.toBe('America/Los_Angeles');
  });

  it('still answers when the store fails: the browser’s zone, or nothing known', async () => {
    const failing = {
      get: () => Promise.reject(new Error('The database is busy.')),
      importSettings: () => Promise.reject(new Error('The database is busy.')),
    };
    const zoneOf = turnTimezoneFor({ reachSettings: failing, knownTimezone: () => Promise.resolve('UTC'), logger });
    await expect(zoneOf({ owner: OWNER, clientTimezone: 'America/Los_Angeles' })).resolves.toBe('America/Los_Angeles');
    await expect(zoneOf({ owner: OWNER, clientTimezone: undefined })).resolves.toBeUndefined();
  });
});
