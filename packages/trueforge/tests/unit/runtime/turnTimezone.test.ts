import { createLogger } from 'winston';

import type { PersonOwner } from '../../../src/db/personOwner';
import type { IPersonTimezoneStore } from '../../../src/db/personTimezoneStore';
import { turnTimezoneFor } from '../../../src/runtime/turnTimezone';
import { defaultReachSettings, type ReachSettings } from '../../../src/schemas/reach';

const OWNER: PersonOwner = { tenant_id: 'default', created_by: 'owner-1' };
const OTHER: PersonOwner = { tenant_id: 'default', created_by: 'owner-2' };
const logger = createLogger({ silent: true });

/** Browser zones kept in memory, one per person. */
function zoneStore() {
  const zones = new Map<string, string>();
  const get = jest.fn<ReturnType<IPersonTimezoneStore['get']>, Parameters<IPersonTimezoneStore['get']>>(owner =>
    Promise.resolve(zones.get(owner.created_by)),
  );
  const put = jest.fn<ReturnType<IPersonTimezoneStore['put']>, Parameters<IPersonTimezoneStore['put']>>(input => {
    zones.set(input.created_by, input.timezone);
    return Promise.resolve();
  });
  return { get, put };
}

function lookup({
  saved,
  browserZones = zoneStore(),
  known,
}: {
  saved?: ReachSettings;
  browserZones?: IPersonTimezoneStore;
  known?: string;
} = {}) {
  const reachGet = jest.fn(() => Promise.resolve(saved));
  const knownTimezone = jest.fn(() => Promise.resolve(known));
  return {
    zoneOf: turnTimezoneFor({ reachSettings: { get: reachGet }, browserZones, knownTimezone, logger }),
    reachGet,
    knownTimezone,
  };
}

describe('the time zone a turn reads the person’s day in', () => {
  it('uses the browser’s zone and keeps it, without touching Reach me', async () => {
    const browserZones = zoneStore();
    const { zoneOf, reachGet, knownTimezone } = lookup({ browserZones, known: 'Europe/Paris' });

    await expect(zoneOf({ owner: OWNER, clientTimezone: 'America/Los_Angeles' })).resolves.toBe('America/Los_Angeles');

    expect(browserZones.put).toHaveBeenCalledWith(
      expect.objectContaining({ ...OWNER, timezone: 'America/Los_Angeles' }),
    );
    expect(reachGet).not.toHaveBeenCalled();
    expect(knownTimezone).not.toHaveBeenCalled();
  });

  it('writes the kept zone only when it is new or has changed', async () => {
    const browserZones = zoneStore();
    const { zoneOf } = lookup({ browserZones });

    await zoneOf({ owner: OWNER, clientTimezone: 'America/Los_Angeles' });
    await zoneOf({ owner: OWNER, clientTimezone: 'America/Los_Angeles' });
    await zoneOf({ owner: OWNER, clientTimezone: 'America/Los_Angeles' });
    expect(browserZones.put).toHaveBeenCalledTimes(1);
    expect(browserZones.get).toHaveBeenCalledTimes(1);

    // The person travels: the newest browser zone is the one kept.
    await zoneOf({ owner: OWNER, clientTimezone: 'Asia/Tokyo' });
    expect(browserZones.put).toHaveBeenCalledTimes(2);
    await expect(zoneOf({ owner: OWNER, clientTimezone: undefined })).resolves.toBe('Asia/Tokyo');
  });

  it('does not write again after a restart when the kept zone is already the browser’s', async () => {
    const browserZones = zoneStore();
    await lookup({ browserZones }).zoneOf({ owner: OWNER, clientTimezone: 'America/Los_Angeles' });
    await lookup({ browserZones }).zoneOf({ owner: OWNER, clientTimezone: 'America/Los_Angeles' });
    expect(browserZones.put).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, '', 'Not/A_Zone'])(
    'looks the zone up for a message that brings %p: Reach me, then the last browser, then schedules or the calendar',
    async clientTimezone => {
      const browserZones = zoneStore();
      await browserZones.put({ ...OWNER, timezone: 'Asia/Tokyo' });

      // What the person saved themselves comes first.
      const saved = lookup({ saved: defaultReachSettings('America/Los_Angeles'), browserZones, known: 'Europe/Paris' });
      await expect(saved.zoneOf({ owner: OWNER, clientTimezone })).resolves.toBe('America/Los_Angeles');
      expect(saved.knownTimezone).not.toHaveBeenCalled();

      const unsaved = lookup({ browserZones, known: 'Europe/Paris' });
      await expect(unsaved.zoneOf({ owner: OWNER, clientTimezone })).resolves.toBe('Asia/Tokyo');
      expect(unsaved.knownTimezone).not.toHaveBeenCalled();

      // Someone who never used a browser: their schedules or calendar say.
      await expect(unsaved.zoneOf({ owner: OTHER, clientTimezone })).resolves.toBe('Europe/Paris');
      // A looked-up zone is never kept as a browser's.
      expect(browserZones.put).toHaveBeenCalledTimes(1);
    },
  );

  it('says nothing is known when no browser, Reach me, schedule or calendar gives a zone', async () => {
    await expect(lookup().zoneOf({ owner: OWNER, clientTimezone: undefined })).resolves.toBeUndefined();
  });

  it('never gives one person another person’s zone', async () => {
    const { zoneOf } = lookup();
    await zoneOf({ owner: OWNER, clientTimezone: 'America/Los_Angeles' });
    await expect(zoneOf({ owner: OTHER, clientTimezone: undefined })).resolves.toBeUndefined();
  });

  it('still answers when the store fails: the browser’s zone, or nothing known', async () => {
    const failing: IPersonTimezoneStore = {
      get: () => Promise.reject(new Error('The database is busy.')),
      put: () => Promise.reject(new Error('The database is busy.')),
    };
    const { zoneOf } = lookup({ browserZones: failing, known: 'Europe/Paris' });
    await expect(zoneOf({ owner: OWNER, clientTimezone: 'America/Los_Angeles' })).resolves.toBe('America/Los_Angeles');
    await expect(zoneOf({ owner: OWNER, clientTimezone: undefined })).resolves.toBeUndefined();
  });
});
