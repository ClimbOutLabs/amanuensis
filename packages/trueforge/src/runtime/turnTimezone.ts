import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import { isValidTimezone } from '@truefoundry/trueforge-core/core/util/clientTimezone';
import type { Logger } from 'winston';

import type { PersonOwner } from '../db/personOwner';
import type { IReachSettingsStore } from '../db/reachSettingsStore';
import { defaultReachSettings } from '../schemas/reach';

/** The time zone a turn reads the person's day in; undefined when nothing says where they are. */
export type TurnTimezone = (input: {
  owner: PersonOwner;
  /** The zone the person's browser sent with the message, when it came from one. */
  clientTimezone: string | undefined;
}) => Promise<string | undefined>;

/**
 * A message from a browser says the person's zone. One that comes another way, such as from Telegram, carries only
 * the instant it was sent, so its zone is looked up: the one saved in Reach me, else the one their schedules or
 * calendar use. A browser's zone is saved to Reach me when the person has none there yet, so anyone who has used
 * the app once has a zone for every other way in. Never throws.
 */
export function turnTimezoneFor({
  reachSettings,
  knownTimezone,
  logger,
}: {
  reachSettings: Pick<IReachSettingsStore, 'get' | 'importSettings'>;
  /** The zone the person's schedules or calendar give. */
  knownTimezone: (owner: PersonOwner) => Promise<string | undefined>;
  logger: Logger;
}): TurnTimezone {
  // People known to have Reach me settings, so a browser message reads the store for them once and not every time.
  const haveSettings = new Set<string>();
  const remember = async ({ owner, timezone }: { owner: PersonOwner; timezone: string }): Promise<void> => {
    const key = `${owner.tenant_id}\u0000${owner.created_by}`;
    if (haveSettings.has(key)) {
      return;
    }
    try {
      if ((await reachSettings.get(owner)) === undefined) {
        // Added only when there are none, so settings the person saved in the meantime are never replaced.
        await reachSettings.importSettings({ ...owner, settings: defaultReachSettings(timezone) });
      }
      haveSettings.add(key);
    } catch (error) {
      logger.warn('The time zone from a browser could not be saved for later.', extractErrorLogFields(error));
    }
  };
  return async ({ owner, clientTimezone }) => {
    if (clientTimezone !== undefined && clientTimezone !== '' && isValidTimezone(clientTimezone)) {
      await remember({ owner, timezone: clientTimezone });
      return clientTimezone;
    }
    try {
      return (await reachSettings.get(owner))?.timezone ?? (await knownTimezone(owner));
    } catch (error) {
      logger.warn('The time zone for a message with none could not be looked up.', extractErrorLogFields(error));
      return undefined;
    }
  };
}
