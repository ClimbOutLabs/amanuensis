import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import { isValidTimezone } from '@truefoundry/trueforge-core/core/util/clientTimezone';
import type { Logger } from 'winston';

import type { PersonOwner } from '../db/personOwner';
import type { IPersonTimezoneStore } from '../db/personTimezoneStore';
import type { IReachSettingsStore } from '../db/reachSettingsStore';

/** The time zone a turn reads the person's day in; undefined when nothing says where they are. */
export type TurnTimezone = (input: {
  owner: PersonOwner;
  /** The zone the person's browser sent with the message, when it came from one. */
  clientTimezone: string | undefined;
}) => Promise<string | undefined>;

/**
 * A message from a browser says the person's zone, and that zone is kept. One that comes another way, such as from
 * Telegram, carries only the instant it was sent, so its zone is looked up: the one the person saved in Reach me,
 * else the one their browser last gave, else the one their schedules or calendar use. Never throws.
 */
export function turnTimezoneFor({
  reachSettings,
  browserZones,
  knownTimezone,
  logger,
}: {
  reachSettings: Pick<IReachSettingsStore, 'get'>;
  /** The zone each person's browser last gave. */
  browserZones: IPersonTimezoneStore;
  /** The zone the person's schedules or calendar give. */
  knownTimezone: (owner: PersonOwner) => Promise<string | undefined>;
  logger: Logger;
}): TurnTimezone {
  // The zone last kept for each person, so a browser message writes only when the zone is new or has changed.
  const kept = new Map<string, string>();
  const keep = async ({ owner, timezone }: { owner: PersonOwner; timezone: string }): Promise<void> => {
    const key = `${owner.tenant_id}\u0000${owner.created_by}`;
    if (kept.get(key) === timezone) {
      return;
    }
    try {
      if ((await browserZones.get(owner)) !== timezone) {
        await browserZones.put({ ...owner, timezone });
      }
      kept.set(key, timezone);
    } catch (error) {
      logger.warn('The time zone from a browser could not be kept for later.', extractErrorLogFields(error));
    }
  };
  return async ({ owner, clientTimezone }) => {
    if (clientTimezone !== undefined && clientTimezone !== '' && isValidTimezone(clientTimezone)) {
      await keep({ owner, timezone: clientTimezone });
      return clientTimezone;
    }
    try {
      return (
        (await reachSettings.get(owner))?.timezone ?? (await browserZones.get(owner)) ?? (await knownTimezone(owner))
      );
    } catch (error) {
      logger.warn('The time zone for a message with none could not be looked up.', extractErrorLogFields(error));
      return undefined;
    }
  };
}
