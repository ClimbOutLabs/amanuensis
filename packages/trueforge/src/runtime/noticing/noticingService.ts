import {
  emptyChatProvenance,
  namesUrl,
  recordPersonText,
  recordUntrustedText,
  steeredDestinations,
  type ReadSource,
} from '@truefoundry/trueforge-core/core/permissions/provenance';
import type { Logger } from 'winston';

import type { INoticingStore } from '../../db/noticingStore';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { DeliveryLevel } from '../../schemas/deliveries';
import {
  defaultReachSettings,
  type NoticingEvent,
  type NoticingWatcher,
  type ReachSettings,
} from '../../schemas/reach';
import type { DeliveryService } from '../delivery/deliveryService';
import { TokenFactoryDailyCapError, type TokenFactoryBudget } from '../tokenFactoryBudget';
import type { JudgeVerdict, NoticingJudge } from './judge';
import { startOfLocalDay } from './quietHours';
import type { ReachChannels } from './reachChannels';
import { applyReachRules, joinReasons } from './reachRules';
import type { ApprovalSource, CalendarSource, MailSource, NoticingOwner, NoticingSourceProvider } from './sources';
import { BILL_WINDOW_MS, billIsPaid, watchApprovals, watchCalendar, watchMail } from './watchers';

/** How far back the first pass of a mail watcher looks, so a newly connected inbox is not flooded with old mail. */
const FIRST_LOOKBACK_MS = 10 * 60_000;
/** Each pass looks a little before the last check, so mail that arrived while it ran is not missed. Stable ids absorb the repeat. */
const CHECK_OVERLAP_MS = 2 * 60_000;
const TRACKING_LIMIT = 50;

export interface NoticingService {
  /** Runs one pass of one watcher for everyone it can watch. */
  run(input: { watcher: NoticingWatcher }): Promise<{ owners: number; raised: number }>;
}

export interface NoticingDeps {
  sources: NoticingSourceProvider;
  approvals: ApprovalSource;
  reachSettings: IReachSettingsStore;
  store: INoticingStore;
  deliveries: Pick<DeliveryService, 'deliver'>;
  /** The model call for "does this matter", made once per event. It throws when no model can answer. */
  judgeFor: (owner: NoticingOwner) => Promise<NoticingJudge>;
  budget: Pick<TokenFactoryBudget, 'isExhausted'>;
  channels: () => ReachChannels;
  logger: Logger;
  now?: () => Date;
}

const READ_SOURCE: Record<NoticingEvent['kind'], ReadSource> = {
  reminder: 'other',
  mail_always: 'email',
  bill_due: 'email',
  calendar_clash: 'event',
  travel: 'event',
  approval_waiting: 'other',
};

/**
 * A message that may reach the person: the model's sentence, unless it carries a link or an address that only
 * read content named. Read content steers nothing, so such a message is replaced by the plain sentence the watcher
 * wrote itself. The always-important addresses are the person's own words.
 */
function usableMessage({
  event,
  message,
  settings,
}: {
  event: NoticingEvent;
  message: string;
  settings: ReachSettings;
}): { text: string; replaced: boolean } {
  const provenance = emptyChatProvenance();
  for (const sender of settings.always_important) {
    recordPersonText({ provenance, text: sender.address });
  }
  recordUntrustedText({ provenance, text: event.facts, source: READ_SOURCE[event.kind] });
  const steered = steeredDestinations({ provenance, addresses: [], values: [message], reply_sender: null });
  if (namesUrl([message]) || steered.length > 0) {
    return { text: event.summary, replaced: true };
  }
  return { text: message, replaced: false };
}

export function createNoticingService(deps: NoticingDeps): NoticingService {
  const now = deps.now ?? (() => new Date());
  const { store, logger } = deps;

  /** Asks the model once, unless the day's token cap is used up. A failure never loses the event: it becomes a note. */
  async function ask({
    owner,
    event,
  }: {
    owner: NoticingOwner;
    event: NoticingEvent;
  }): Promise<{ verdict: JudgeVerdict | undefined; why: string }> {
    if (await deps.budget.isExhausted()) {
      return { verdict: undefined, why: 'The model has used its limit for today, so this is a plain note.' };
    }
    try {
      return { verdict: await (await deps.judgeFor(owner))({ event }), why: '' };
    } catch (error) {
      if (error instanceof TokenFactoryDailyCapError) {
        return { verdict: undefined, why: 'The model has used its limit for today, so this is a plain note.' };
      }
      logger.warn('The noticing model could not answer', {
        event_id: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { verdict: undefined, why: 'The model could not be asked, so this is a plain note.' };
    }
  }

  /** Decides one event the store has already claimed, and delivers it. Resolves to true when it was delivered. */
  async function raise({
    owner,
    event,
    settings,
    freshClaim,
  }: {
    owner: NoticingOwner;
    event: NoticingEvent;
    settings: ReachSettings;
    freshClaim: boolean;
  }): Promise<boolean> {
    try {
      const at = now();
      const { verdict, why } = await ask({ owner, event });
      const message =
        verdict === undefined
          ? { text: event.summary, replaced: false }
          : usableMessage({ event, message: verdict.message, settings });
      const history = {
        nudges_today: await store.countNudgesSince({
          ...owner,
          since: startOfLocalDay({ now: at, timezone: settings.timezone }),
        }),
        last_call_at: await store.lastCallDecidedAt(owner),
      };
      const decision = applyReachRules({
        subject:
          event.kind === 'reminder'
            ? { kind: 'reminder', urgent: false }
            : { kind: event.kind, evidence: event.evidence },
        asked: verdict?.level ?? 'note',
        settings,
        history,
        now: at,
        calls_available: deps.channels().calls.available,
      });
      const reason = joinReasons([
        event.matched,
        verdict?.reason ?? why,
        message.replaced
          ? 'The model’s wording carried a link or address from the message, so the plain sentence is used.'
          : '',
        ...decision.steps,
      ]);
      const level: DeliveryLevel = decision.delivered;
      const delivery = await deps.deliveries.deliver({
        ...owner,
        kind: level === 'note' ? 'note' : 'nudge',
        level,
        text: message.text,
        reason,
        link: event.link,
      });
      await store.decide({
        ...owner,
        event_id: event.id,
        decision: {
          model_level: verdict?.level ?? null,
          decided_level: decision.decided,
          delivered_level: decision.delivered,
          reason,
          delivery_id: delivery.id,
        },
        now: at,
      });
      return true;
    } catch (error) {
      if (freshClaim) {
        await store.release({ ...owner, event_id: event.id });
      }
      throw error;
    }
  }

  async function claimAndRaise({
    owner,
    events,
    settings,
  }: {
    owner: NoticingOwner;
    events: readonly NoticingEvent[];
    settings: ReachSettings;
  }): Promise<number> {
    let raised = 0;
    for (const event of events) {
      if ((await store.claim({ ...owner, event, status: 'raised', now: now() })) === 'seen') {
        continue;
      }
      try {
        if (await raise({ owner, event, settings, freshClaim: true })) {
          raised += 1;
        }
      } catch (error) {
        logger.error('A noticed event could not be delivered; it will be tried again', {
          event_id: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return raised;
  }

  async function runMail({
    owner,
    mail,
    settings,
  }: {
    owner: NoticingOwner;
    mail: MailSource;
    settings: ReachSettings;
  }): Promise<number> {
    const at = now();
    const checked = await store.getCheckpoint({ ...owner, watcher: 'mail' });
    const since = new Date((checked?.getTime() ?? at.getTime() - FIRST_LOOKBACK_MS) - CHECK_OVERLAP_MS);
    const findings = await watchMail({ source: mail, settings, since, now: at });
    let raised = await claimAndRaise({ owner, events: findings.raise, settings });
    for (const event of findings.track) {
      await store.claim({ ...owner, event, status: 'tracking', now: at });
    }
    raised += await raiseTrackedBills({ owner, mail, settings, now: at });
    await store.setCheckpoint({ ...owner, watcher: 'mail', checked_at: at });
    return raised;
  }

  /** Bills seen earlier that now fall due within three days, unless something since says they were paid. */
  async function raiseTrackedBills({
    owner,
    mail,
    settings,
    now: at,
  }: {
    owner: NoticingOwner;
    mail: MailSource;
    settings: ReachSettings;
    now: Date;
  }): Promise<number> {
    const due = await store.listTracking({
      ...owner,
      due_before: new Date(at.getTime() + BILL_WINDOW_MS),
      limit: TRACKING_LIMIT,
    });
    let raised = 0;
    for (const record of due) {
      const deadline = record.event.due_at === null ? undefined : new Date(record.event.due_at);
      if (
        deadline === undefined ||
        deadline.getTime() < at.getTime() ||
        (await billIsPaid({ source: mail, event: record.event }))
      ) {
        await store.drop({ ...owner, event_id: record.event.id });
        continue;
      }
      try {
        if (await raise({ owner, event: record.event, settings, freshClaim: false })) {
          raised += 1;
        }
      } catch (error) {
        logger.error('A tracked bill could not be delivered; it will be tried again', {
          event_id: record.event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return raised;
  }

  async function runCalendar({
    owner,
    calendar,
    settings,
  }: {
    owner: NoticingOwner;
    calendar: CalendarSource;
    settings: ReachSettings;
  }): Promise<number> {
    const at = now();
    const events = await watchCalendar({ source: calendar, settings, now: at });
    const raised = await claimAndRaise({ owner, events, settings });
    await store.setCheckpoint({ ...owner, watcher: 'calendar', checked_at: at });
    return raised;
  }

  async function runApprovals({ owner, settings }: { owner: NoticingOwner; settings: ReachSettings }): Promise<number> {
    const at = now();
    const events = await watchApprovals({ source: deps.approvals, owner, settings, now: at });
    const raised = await claimAndRaise({ owner, events, settings });
    await store.setCheckpoint({ ...owner, watcher: 'approvals', checked_at: at });
    return raised;
  }

  async function ownersToWatch(): Promise<NoticingOwner[]> {
    const listed = [...(await deps.sources.listOwners()), ...(await deps.reachSettings.listOwners())];
    const seen = new Set<string>();
    return listed.filter(owner => {
      const key = `${owner.tenant_id}\u0000${owner.created_by}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  return {
    async run({ watcher }) {
      const owners = await ownersToWatch();
      let raised = 0;
      for (const owner of owners) {
        try {
          const settings = (await deps.reachSettings.get(owner)) ?? defaultReachSettings('UTC');
          if (watcher === 'approvals') {
            raised += await runApprovals({ owner, settings });
            continue;
          }
          const sources = await deps.sources.sourcesFor(owner);
          if (watcher === 'mail' && sources.mail !== undefined) {
            raised += await runMail({ owner, mail: sources.mail, settings });
          }
          if (watcher === 'calendar' && sources.calendar !== undefined) {
            raised += await runCalendar({ owner, calendar: sources.calendar, settings });
          }
        } catch (error) {
          logger.error('A noticing pass failed for one person; the others go on', {
            watcher,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { owners: owners.length, raised };
    },
  };
}
