import { APPROVAL_EXPIRY_MINUTES } from '@truefoundry/trueforge-core/core/permissions/approvalExpiry';
import {
  emptyChatProvenance,
  namesPhoneNumber,
  namesUrl,
  recordPersonText,
  recordUntrustedText,
  steeredDestinations,
  type ReadSource,
} from '@truefoundry/trueforge-core/core/permissions/provenance';
import type { Logger } from 'winston';

import type { IDeliveryStore } from '../../db/deliveryStore';
import type { INoticingStore, NoticingOwner } from '../../db/noticingStore';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { Delivery, DeliveryLevel } from '../../schemas/deliveries';
import {
  defaultReachSettings,
  type NoticingEvent,
  type NoticingKind,
  type NoticingWatcher,
  type ReachSettings,
} from '../../schemas/reach';
import { newId } from '../../utils/id';
import type { DeliveryService } from '../delivery/deliveryService';
import { TokenFactoryDailyCapError, type TokenFactoryBudget } from '../tokenFactoryBudget';
import type { JudgeVerdict, NoticingJudge } from './judge';
import { ceilingOf } from './levels';
import type { ReachChannels } from './reachChannels';
import { readReachHistory, waitFor, withReachLease, type ReachGateDeps } from './reachGate';
import { applyReachRules, joinReasons } from './reachRules';
import type { ApprovalSource, CalendarSource, MailSource, NoticingSourceProvider } from './sources';
import { BILL_WINDOW_MS, billIsPaid, watchApprovals, watchCalendar, watchMail } from './watchers';

/** How far back the first pass of a mail watcher looks, so a newly connected inbox is not flooded with old mail. */
const FIRST_LOOKBACK_MS = 10 * 60_000;
/** Each pass looks a little before the last check, so mail that arrived while it ran is not missed. Stable ids absorb the repeat. */
const CHECK_OVERLAP_MS = 2 * 60_000;
const TRACKING_LIMIT = 50;
const PENDING_LIMIT = 50;
/** A claim this old belongs to a pass that stopped part way, so another pass may take the event over. */
const CLAIM_STALE_MS = 10 * 60_000;

/** The kinds each watcher finds, so a pass raises only its own pending events. */
const WATCHER_KINDS: Record<NoticingWatcher, readonly NoticingKind[]> = {
  mail: ['mail_always', 'bill_due'],
  calendar: ['calendar_clash', 'travel'],
  approvals: ['approval_waiting'],
};

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
  /** The feed, read for how many nudges and calls already went out. */
  history: Pick<IDeliveryStore, 'countSince' | 'lastCreatedAt'>;
  /** The model call for "does this matter", made once per event. It throws when no model can answer. */
  judgeFor: (owner: NoticingOwner) => Promise<NoticingJudge>;
  budget: Pick<TokenFactoryBudget, 'isExhausted'>;
  channels: () => ReachChannels;
  logger: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const READ_SOURCE: Record<NoticingKind, ReadSource> = {
  mail_always: 'email',
  bill_due: 'email',
  calendar_clash: 'event',
  travel: 'event',
  approval_waiting: 'other',
};

const ONLY_WORDS = 'Only the words in a message said this mattered, so it stays a note.';

/**
 * Whether the model's words may reach the person as they are. Read content steers nothing, so words that carry a link,
 * a phone number, or an address only read content named are never shown. The always-important addresses are the
 * person's own words.
 */
function usableWords({
  event,
  words,
  settings,
}: {
  event: NoticingEvent;
  words: string;
  settings: ReachSettings;
}): boolean {
  const provenance = emptyChatProvenance();
  for (const sender of settings.always_important) {
    recordPersonText({ provenance, text: sender.address });
  }
  recordUntrustedText({ provenance, text: event.facts, source: READ_SOURCE[event.kind] });
  const steered = steeredDestinations({ provenance, addresses: [], values: [words], reply_sender: null });
  return !namesUrl([words]) && !namesPhoneNumber([words]) && steered.length === 0;
}

/** The model's message and reason as they may be shown, each replaced by plain words when it cannot be. */
function shownWords({
  event,
  verdict,
  settings,
}: {
  event: NoticingEvent;
  verdict: JudgeVerdict;
  settings: ReachSettings;
}): { text: string; reason: string; replaced: boolean } {
  const messageOk = usableWords({ event, words: verdict.message, settings });
  return {
    text: messageOk ? verdict.message : event.summary,
    reason: usableWords({ event, words: verdict.reason, settings })
      ? verdict.reason
      : `The model asked for a ${verdict.level}.`,
    replaced: !messageOk,
  };
}

/** Whether an event is still worth saying: a clash or a trip that already started, or a closed request, is not. */
function stillTimely({ event, now }: { event: NoticingEvent; now: Date }): boolean {
  const at = now.getTime();
  switch (event.kind) {
    case 'calendar_clash':
    case 'travel':
      return new Date(event.occurred_at).getTime() > at;
    case 'approval_waiting':
      return new Date(event.occurred_at).getTime() + APPROVAL_EXPIRY_MINUTES * 60_000 > at;
    case 'bill_due':
      return event.due_at === null || new Date(event.due_at).getTime() > at;
    case 'mail_always':
      return true;
  }
}

function deliveryKindOf(level: DeliveryLevel): Delivery['kind'] {
  return level === 'note' ? 'note' : 'nudge';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createNoticingService(deps: NoticingDeps): NoticingService {
  const now = deps.now ?? (() => new Date());
  const { store, logger } = deps;
  const gate: ReachGateDeps = { store, history: deps.history, logger, now, sleep: deps.sleep ?? waitFor };

  /**
   * Asks the model once, unless the event can only ever be a note or the day's token cap is used up. A failure never
   * loses the event: it becomes a note.
   */
  async function ask({
    owner,
    event,
  }: {
    owner: NoticingOwner;
    event: NoticingEvent;
  }): Promise<{ verdict: JudgeVerdict | undefined; why: string }> {
    if (ceilingOf(event) === 'note') {
      return { verdict: undefined, why: ONLY_WORDS };
    }
    if (await deps.budget.isExhausted()) {
      return { verdict: undefined, why: 'The model has used its limit for today, so this is a plain note.' };
    }
    try {
      return { verdict: await (await deps.judgeFor(owner))({ event }), why: '' };
    } catch (error) {
      if (error instanceof TokenFactoryDailyCapError) {
        return { verdict: undefined, why: 'The model has used its limit for today, so this is a plain note.' };
      }
      logger.warn('The noticing model could not answer', { event_id: event.id, error: errorText(error) });
      return { verdict: undefined, why: 'The model could not be asked, so this is a plain note.' };
    }
  }

  /**
   * Decides and delivers one event this pass has claimed. The model is asked first; the person's limits are read and
   * applied while holding their reach lease, right before delivering, so two passes cannot both spend the last nudge.
   * Resolves to `busy` when another pass kept the lease, and the event waits for the next pass.
   */
  async function raise({
    owner,
    event,
    settings,
    claim_id,
  }: {
    owner: NoticingOwner;
    event: NoticingEvent;
    settings: ReachSettings;
    claim_id: string;
  }): Promise<'raised' | 'busy'> {
    const { verdict, why } = await ask({ owner, event });
    const shown =
      verdict === undefined
        ? { text: event.summary, reason: why, replaced: false }
        : shownWords({ event, verdict, settings });
    const outcome = await withReachLease({
      deps: gate,
      owner,
      work: async () => {
        const at = now();
        const decision = applyReachRules({
          subject: { kind: event.kind, evidence: event.evidence },
          asked: verdict?.level ?? 'note',
          settings,
          history: await readReachHistory({ history: deps.history, owner, timezone: settings.timezone, now: at }),
          now: at,
          calls_available: deps.channels().calls.available,
        });
        const reason = joinReasons([
          event.matched,
          shown.reason,
          shown.replaced
            ? 'The model’s wording carried a link, a number or an address, so the plain sentence is used.'
            : '',
          ...decision.steps,
        ]);
        const delivery = await deps.deliveries.deliver({
          ...owner,
          kind: deliveryKindOf(decision.delivered),
          level: decision.delivered,
          text: shown.text,
          reason,
          link: event.link,
          created_at: at,
        });
        const kept = await store.decide({
          ...owner,
          event_id: event.id,
          claim_id,
          decision: {
            model_level: verdict?.level ?? null,
            decided_level: decision.decided,
            delivered_level: decision.delivered,
            reason,
            delivery_id: delivery.id,
          },
          now: at,
        });
        if (!kept) {
          logger.warn('A noticed event was delivered after its claim had gone stale', { event_id: event.id });
        }
      },
    });
    return outcome.held ? 'raised' : 'busy';
  }

  /** Raises every pending event of this watcher's kinds that no other pass is working on. */
  async function raisePending({
    owner,
    watcher,
    settings,
  }: {
    owner: NoticingOwner;
    watcher: NoticingWatcher;
    settings: ReachSettings;
  }): Promise<number> {
    const stale_before = new Date(now().getTime() - CLAIM_STALE_MS);
    const pending = await store.listPending({
      ...owner,
      kinds: WATCHER_KINDS[watcher],
      stale_before,
      limit: PENDING_LIMIT,
    });
    let raised = 0;
    for (const event of pending) {
      if (!stillTimely({ event, now: now() })) {
        await store.drop({ ...owner, event_id: event.id });
        continue;
      }
      const claim_id = newId();
      if (!(await store.claim({ ...owner, event_id: event.id, claim_id, now: now(), stale_before }))) {
        continue;
      }
      try {
        if ((await raise({ owner, event, settings, claim_id })) === 'raised') {
          raised += 1;
        } else {
          await store.release({ ...owner, event_id: event.id, claim_id, failed: false });
        }
      } catch (error) {
        const left = await store
          .release({ ...owner, event_id: event.id, claim_id, failed: true })
          .catch((): 'pending' => 'pending');
        logger.error(
          left === 'failed'
            ? 'A noticed event failed too many times and was given up'
            : 'A noticed event could not be delivered; the next pass tries again',
          { event_id: event.id, error: errorText(error) },
        );
      }
    }
    return raised;
  }

  async function recordAll({
    owner,
    events,
    status,
  }: {
    owner: NoticingOwner;
    events: readonly NoticingEvent[];
    status: 'pending' | 'tracking';
  }): Promise<void> {
    for (const event of events) {
      await store.record({ ...owner, event, status, now: now() });
    }
  }

  async function runMail({
    owner,
    mail,
    settings,
  }: {
    owner: NoticingOwner;
    mail: MailSource;
    settings: ReachSettings;
  }): Promise<void> {
    const at = now();
    const checked = await store.getCheckpoint({ ...owner, watcher: 'mail' });
    const since = new Date((checked?.getTime() ?? at.getTime() - FIRST_LOOKBACK_MS) - CHECK_OVERLAP_MS);
    const findings = await watchMail({ source: mail, settings, since, now: at });
    await recordAll({ owner, events: findings.raise, status: 'pending' });
    await recordAll({ owner, events: findings.track, status: 'tracking' });
    // Everything found is written down before the checkpoint moves, so a failed delivery is retried from the store.
    await store.setCheckpoint({ ...owner, watcher: 'mail', checked_at: at });
    await promoteDueBills({ owner, mail, now: at });
  }

  /** Bills seen earlier that now fall due within three days become pending, unless something since says they were paid. */
  async function promoteDueBills({ owner, mail, now: at }: { owner: NoticingOwner; mail: MailSource; now: Date }) {
    const due = await store.listTracking({
      ...owner,
      due_before: new Date(at.getTime() + BILL_WINDOW_MS),
      limit: TRACKING_LIMIT,
    });
    for (const event of due) {
      const deadline = event.due_at === null ? undefined : new Date(event.due_at);
      if (deadline === undefined || deadline.getTime() < at.getTime() || (await billIsPaid({ source: mail, event }))) {
        await store.drop({ ...owner, event_id: event.id });
        continue;
      }
      await store.promote({ ...owner, event_id: event.id });
    }
  }

  async function runCalendar({
    owner,
    calendar,
    settings,
  }: {
    owner: NoticingOwner;
    calendar: CalendarSource;
    settings: ReachSettings;
  }): Promise<void> {
    await recordAll({
      owner,
      events: await watchCalendar({ source: calendar, settings, now: now() }),
      status: 'pending',
    });
  }

  async function runApprovals({ owner, settings }: { owner: NoticingOwner; settings: ReachSettings }): Promise<void> {
    const events = await watchApprovals({ source: deps.approvals, owner, settings, now: now() });
    await recordAll({ owner, events, status: 'pending' });
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

  async function look({
    owner,
    watcher,
    settings,
  }: {
    owner: NoticingOwner;
    watcher: NoticingWatcher;
    settings: ReachSettings;
  }): Promise<void> {
    if (watcher === 'approvals') {
      await runApprovals({ owner, settings });
      return;
    }
    const sources = await deps.sources.sourcesFor(owner);
    if (watcher === 'mail' && sources.mail !== undefined) {
      await runMail({ owner, mail: sources.mail, settings });
    }
    if (watcher === 'calendar' && sources.calendar !== undefined) {
      await runCalendar({ owner, calendar: sources.calendar, settings });
    }
  }

  return {
    async run({ watcher }) {
      const owners = await ownersToWatch();
      let raised = 0;
      for (const owner of owners) {
        try {
          const settings = (await deps.reachSettings.get(owner)) ?? defaultReachSettings('UTC');
          try {
            await look({ owner, watcher, settings });
          } catch (error) {
            // What earlier passes found is still raised below.
            logger.error('A watcher could not look for one person; the others go on', {
              watcher,
              error: errorText(error),
            });
          }
          raised += await raisePending({ owner, watcher, settings });
        } catch (error) {
          logger.error('A noticing pass failed for one person; the others go on', { watcher, error: errorText(error) });
        }
      }
      return { owners: owners.length, raised };
    },
  };
}
