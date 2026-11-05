import type { INoticingStore } from '../../db/noticingStore';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { DeliveryLevel } from '../../schemas/deliveries';
import { defaultReachSettings } from '../../schemas/reach';
import { startOfLocalDay } from './quietHours';
import type { ReachChannels } from './reachChannels';
import { applyReachRules } from './reachRules';
import type { NoticingOwner } from './sources';

export interface ReminderReachDecision {
  /** The level the person's rules settle on. A phone channel set up later acts on `call`. */
  decided: DeliveryLevel;
  /** The level that goes out now. A reminder is never quieter than a nudge. */
  delivered: DeliveryLevel;
  steps: string[];
}

/**
 * How a due reminder reaches the person: through the same channels and rules as anything else the assistant notices.
 * It is always at least a nudge, and calls only when the person ticked "call me for reminders I mark urgent".
 */
export interface ReminderReach {
  decide(input: { owner: NoticingOwner; urgent: boolean }): Promise<ReminderReachDecision>;
  /** Writes the decision down, so a reminder that called counts toward the time between calls. */
  record(input: {
    owner: NoticingOwner;
    reminder_run_id: string;
    decision: ReminderReachDecision;
    reason: string;
    delivery_id: string;
  }): Promise<void>;
}

export function createReminderReach({
  reachSettings,
  store,
  channels,
  now = () => new Date(),
}: {
  reachSettings: Pick<IReachSettingsStore, 'get'>;
  store: Pick<INoticingStore, 'claim' | 'decide' | 'lastCallDecidedAt' | 'countNudgesSince'>;
  channels: () => ReachChannels;
  now?: () => Date;
}): ReminderReach {
  return {
    async decide({ owner, urgent }) {
      const settings = (await reachSettings.get(owner)) ?? defaultReachSettings('UTC');
      const at = now();
      const decision = applyReachRules({
        subject: { kind: 'reminder', urgent },
        asked: urgent ? 'call' : 'nudge',
        settings,
        history: {
          nudges_today: await store.countNudgesSince({
            ...owner,
            since: startOfLocalDay({ now: at, timezone: settings.timezone }),
          }),
          last_call_at: await store.lastCallDecidedAt(owner),
        },
        now: at,
        calls_available: channels().calls.available,
      });
      return { decided: decision.decided, delivered: decision.delivered, steps: decision.steps };
    },
    async record({ owner, reminder_run_id, decision, reason, delivery_id }) {
      const at = now();
      const event_id = `reminder:${reminder_run_id}`;
      await store.claim({
        ...owner,
        event: {
          id: event_id,
          kind: 'reminder',
          evidence: 'own',
          summary: 'A reminder you set came due.',
          facts: '',
          matched: 'You asked to be reminded.',
          link: null,
          mail_ref: null,
          occurred_at: at.toISOString(),
          due_at: null,
        },
        status: 'raised',
        now: at,
      });
      await store.decide({
        ...owner,
        event_id,
        decision: {
          model_level: null,
          decided_level: decision.decided,
          delivered_level: decision.delivered,
          reason,
          delivery_id,
        },
        now: at,
      });
    },
  };
}
