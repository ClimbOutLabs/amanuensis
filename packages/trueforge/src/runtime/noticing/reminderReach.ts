import type { PersonOwner } from '../../db/personOwner';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { Delivery } from '../../schemas/deliveries';
import type { ReachAvailability } from '../../schemas/reach';
import { defaultReachSettings } from '../../schemas/reach';
import { readReachHistory, waitFor, withReachLease, type ReachGateDeps } from './reachGate';
import { applyReachRules, type ReachDecision } from './reachRules';

/**
 * How a due reminder reaches the person: through the same channels and rules as anything else the assistant notices.
 * It is always at least a nudge, never counts toward the daily nudges, and calls only when the person ticked "call me
 * for reminders I mark urgent". `send` makes the delivery at the level decided.
 */
export interface ReminderReach {
  deliver(input: {
    owner: PersonOwner;
    urgent: boolean;
    /** The reminder's own time zone, used for quiet hours when the person never saved Reach me. */
    timezone: string;
    /** When the reminder is going out. */
    at: Date;
    send: (decision: ReachDecision) => Promise<Delivery>;
  }): Promise<Delivery>;
}

const BUSY_STEP = 'Something else was reaching you at the same moment, so this came as a nudge.';

export function createReminderReach({
  reachSettings,
  channels,
  now = () => new Date(),
  sleep = waitFor,
  ...gate
}: {
  reachSettings: Pick<IReachSettingsStore, 'get'>;
  channels: () => ReachAvailability;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
} & Pick<ReachGateDeps, 'store' | 'history' | 'logger'>): ReminderReach {
  const gateDeps: ReachGateDeps = { ...gate, now, sleep };
  return {
    async deliver({ owner, urgent, timezone, at, send }) {
      const settings = (await reachSettings.get(owner)) ?? defaultReachSettings(timezone);
      const decide = async (): Promise<ReachDecision> =>
        applyReachRules({
          subject: { kind: 'reminder', urgent },
          asked: urgent ? 'call' : 'nudge',
          settings,
          history: await readReachHistory({ history: gateDeps.history, owner, timezone: settings.timezone, now: at }),
          now: at,
          calls_available: channels().calls.available,
        });
      const first = await decide();
      if (first.decided !== 'call') {
        // Nothing here can call, so nothing needs to wait for another pass.
        return await send(first);
      }
      // A call is spaced from the last one, so the check and the call happen with no other decision in between.
      const held = await withReachLease({ deps: gateDeps, owner, work: async () => await send(await decide()) });
      return held.held ? held.value : await send({ decided: 'nudge', delivered: 'nudge', steps: [BUSY_STEP] });
    },
  };
}
