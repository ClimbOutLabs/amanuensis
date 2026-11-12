import { APPROVAL_EXPIRY_MINUTES } from '@truefoundry/trueforge-core/core/permissions/approvalExpiry';
import { namesContactDetail } from '@truefoundry/trueforge-core/core/permissions/provenance';
import type { Logger } from 'winston';

import { GoogleReconnectRequiredError } from '@truefoundry/trueforge-core/core/google/errors';
import type { IDeliveryStore } from '../../db/deliveryStore';
import type { INoticingStore, NoticingClaim, WaitingEvent, WatcherCheckpoint } from '../../db/noticingStore';
import type { PersonOwner } from '../../db/personOwner';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { Delivery, DeliveryLevel } from '../../schemas/deliveries';
import type { CalendarProblemKind, MailProblemKind, MailSourceKind, ReachAvailability } from '../../schemas/reach';
import {
  defaultReachSettings,
  type NoticingEvent,
  type NoticingKind,
  type NoticingVerdict,
  type NoticingWatcher,
  type ReachSettings,
  type RunNoticingResult,
} from '../../schemas/reach';
import { newId } from '../../utils/id';
import { UNNAMED_ASSISTANT } from '../chatAssistant';
import type { DeliveryService } from '../delivery/deliveryService';
import { TokenFactoryDailyCapError, type TokenFactoryBudget } from '../tokenFactoryBudget';
import type { NoticingJudge } from './judge';
import { ceilingOf } from './levels';
import { readReachHistory, waitFor, withReachLease, type ReachGateDeps } from './reachGate';
import { applyReachRules, joinReasons } from './reachRules';
import {
  MailLoginFailedError,
  MailSourceBusyError,
  MailTooSlowError,
  MessageUnreadableError,
  type ApprovalSource,
  type CalendarSource,
  type MailMessage,
  type MailRef,
  type MailSource,
  type NoticingSourceProvider,
  type WaitingApproval,
} from './sources';
import {
  BILL_WINDOW_MS,
  billIsPaid,
  gapNote,
  watchApprovals,
  watchCalendar,
  watchMail,
  type LeftBehind,
  type MailFindings,
} from './watchers';

/** How far back the first pass of a mail watcher looks, so a newly connected inbox is not flooded with old mail. */
const FIRST_LOOKBACK_MS = 10 * 60_000;
/**
 * Each pass looks back a while before the last check, so mail the server lists late (an index that lags, or a clock
 * that runs ahead) is not missed. Stable ids absorb the repeat.
 */
const CHECK_OVERLAP_MS = 10 * 60_000;
/** After a long outage, mail older than this is not news any more, so a pass never reads back further. */
const MAX_LOOKBACK_MS = 24 * 3_600_000;
const TRACKING_LIMIT = 50;
const PENDING_LIMIT = 50;
/** Reach me says mail is not being checked once the mail read so far is this far behind the clock. */
const MAIL_PROBLEM_SHOWN_AFTER_MS = 3_600_000;
/**
 * How long one mail pass may start new work, and how many calls to the mail server it may make, shared by the look at
 * tracked bills and the scan of new mail. Each checks before every call, and a call may then take up to its own
 * limit, so a slow pass can still be cut off by a connector session. That ends it as a busy failure, which never
 * counts against a message. Tracked bills may use only the first part, so a slow scan never starves them. A minute
 * leaves room in the connector's four-minute session for opening it and for one last slow call.
 */
const MAIL_PASS_MS = 60_000;
const MAIL_PASS_CALLS = 80;
const TRACKED_BILLS_MS = 20_000;
const TRACKED_BILLS_CALLS = 20;
/** A tracked bill whose thread still cannot be checked is raised once it falls due within this long, since it may be unpaid. */
const UNCHECKED_BILL_RAISED_WITHIN_MS = 24 * 3_600_000;
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
  run(input: { watcher: NoticingWatcher }): Promise<RunNoticingResult>;
}

export interface NoticingDeps {
  sources: NoticingSourceProvider;
  approvals: ApprovalSource;
  reachSettings: IReachSettingsStore;
  store: INoticingStore;
  deliveries: Pick<DeliveryService, 'deliverOnce'>;
  /** The feed, read for how many nudges and calls already went out, and whether a delivery was made. */
  history: Pick<IDeliveryStore, 'countSince' | 'lastCreatedAt' | 'get'>;
  /** The model call for "does this matter", made once per event. It throws when no model can answer. */
  judgeFor: (owner: PersonOwner) => Promise<NoticingJudge>;
  budget: Pick<TokenFactoryBudget, 'isExhausted'>;
  channels: () => ReachAvailability;
  logger: Logger;
  /** The time zone to read the day in for someone who never saved Reach me. */
  timezoneFor: (owner: PersonOwner) => Promise<string>;
  /** What the person calls their assistant, for the fixed notes about mail it could not read. */
  assistantNameFor: (owner: PersonOwner) => Promise<string>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** Why a note about unread mail is never a nudge: it says nothing about what the mail holds. */
const GAP_NOTE_WHY = 'Some mail could not be read, so this stays a note.';
const ONLY_WORDS = 'Only the words in a message said this mattered, so it stays a note.';

/** The model's message and reason as they may be shown, each replaced by plain words when it cannot be. */
function shownWords({ event, verdict }: { event: NoticingEvent; verdict: NoticingVerdict }): {
  text: string;
  reason: string;
  replaced: boolean;
} {
  // A steered model could put a number, a site or an address on the person's lock screen, so its words carry none.
  const messageOk = !namesContactDetail([verdict.message]);
  return {
    text: messageOk ? verdict.message : event.summary,
    reason: namesContactDetail([verdict.reason]) ? `The model asked for a ${verdict.level}.` : verdict.reason,
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

/** A waiting approval keeps its own kind, which leads straight to the request; anything else is a note or a nudge. */
function deliveryKindOf({ event, level }: { event: NoticingEvent; level: DeliveryLevel }): Delivery['kind'] {
  if (event.link?.type === 'approval') {
    return 'approval_waiting';
  }
  return level === 'note' ? 'note' : 'nudge';
}

function ownerKey(owner: PersonOwner): string {
  return `${owner.tenant_id}\u0000${owner.created_by}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The mail trouble to show: whenever the mail read so far is `MAIL_PROBLEM_SHOWN_AFTER_MS` behind the clock, whatever
 * the last pass reported. The kind is what the pass recorded, or slowness when it recorded nothing.
 */
export function mailProblemOf({
  checkpoint,
  now,
}: {
  checkpoint: WatcherCheckpoint | undefined;
  now: Date;
}): { since: Date; kind: MailProblemKind } | undefined {
  if (checkpoint === undefined || now.getTime() - checkpoint.checked_at.getTime() < MAIL_PROBLEM_SHOWN_AFTER_MS) {
    return undefined;
  }
  return { since: checkpoint.failure?.since ?? checkpoint.checked_at, kind: checkpoint.failure?.kind ?? 'too_slow' };
}

/** The calendar trouble to show, once the calendar has gone unchecked for as long as mail must be behind. */
export function calendarProblemOf({
  checkpoint,
  now,
}: {
  checkpoint: WatcherCheckpoint | undefined;
  now: Date;
}): { since: Date; kind: CalendarProblemKind } | undefined {
  const failure = checkpoint?.failure;
  if (failure === undefined || now.getTime() - failure.since.getTime() < MAIL_PROBLEM_SHOWN_AFTER_MS) {
    return undefined;
  }
  return { since: failure.since, kind: failure.kind === 'google_sign_in' ? 'google_sign_in' : 'other' };
}

/** Whether an error, or one it was caused by, matches. */
function causedBy({ error, matches }: { error: unknown; matches: (error: Error) => boolean }): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (matches(current)) {
      return true;
    }
  }
  return false;
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
    owner: PersonOwner;
    event: NoticingEvent;
  }): Promise<{ verdict: NoticingVerdict | undefined; why: string }> {
    if (ceilingOf(event) === 'note') {
      return { verdict: undefined, why: event.id.startsWith('mail_gap:') ? GAP_NOTE_WHY : ONLY_WORDS };
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
   * Decides and delivers one event this pass has claimed. The model is asked once per event; the person's limits are
   * read and applied while holding their reach lease, right before delivering, so two passes cannot both spend the
   * last nudge. The delivery's id was drawn when the event was written, so a retry after it went out makes nothing new.
   * Resolves to `busy` when another pass kept the lease, and to `lost` when another pass took the event over.
   */
  async function raise({
    owner,
    waiting: { event, delivery_id },
    settings,
    claim_id,
    claim,
  }: {
    owner: PersonOwner;
    waiting: WaitingEvent;
    settings: ReachSettings;
    claim_id: string;
    claim: NoticingClaim;
  }): Promise<'raised' | 'busy' | 'lost'> {
    const asked = claim.verdict === null ? await ask({ owner, event }) : { verdict: claim.verdict, why: '' };
    const { verdict, why } = asked;
    if (claim.verdict === null && verdict !== undefined) {
      await store.saveVerdict({ ...owner, event_id: event.id, claim_id, verdict });
    }
    // The fixed sentence is shown as it is: it comes from a confirmed sender, the person's own event, or a note.
    const shown =
      verdict === undefined ? { text: event.summary, reason: why, replaced: false } : shownWords({ event, verdict });
    const outcome = await withReachLease({
      deps: gate,
      owner,
      work: async (): Promise<'raised' | 'lost'> => {
        const at = now();
        if (!(await store.startDelivering({ ...owner, event_id: event.id, claim_id, now: at }))) {
          return 'lost';
        }
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
        const delivery = await deps.deliveries.deliverOnce({
          ...owner,
          id: delivery_id,
          kind: deliveryKindOf({ event, level: decision.delivered }),
          level: decision.delivered,
          text: shown.text,
          reason,
          link: event.link,
          created_at: at,
        });
        // The delivery went out, so a failure to write that down is not a failed try: a later pass that takes the
        // event over finds the delivery already made and only finishes it.
        await store
          .finish({ ...owner, event_id: event.id, claim_id, delivery_id: delivery.id })
          .catch((error: unknown) => {
            logger.warn('A noticed event was delivered but could not be marked done', {
              event_id: event.id,
              error: errorText(error),
            });
          });
        return 'raised';
      },
    });
    return outcome.held ? outcome.value : 'busy';
  }

  /**
   * Stops a waiting event that will never be raised. One a pass left part way through delivering is closed as raised
   * when its delivery was made, since that may have reached the person.
   */
  async function stop({
    owner,
    waiting,
    stale_before,
  }: {
    owner: PersonOwner;
    waiting: WaitingEvent;
    stale_before: Date;
  }): Promise<void> {
    if (waiting.status === 'pending') {
      await store.drop({ ...owner, event_id: waiting.event.id });
      return;
    }
    const made = await deps.history.get({ ...owner, id: waiting.delivery_id });
    await store.settle({
      ...owner,
      event_id: waiting.event.id,
      stale_before,
      status: made === undefined ? 'dropped' : 'raised',
    });
  }

  /**
   * Closes a waiting event with nothing left to send: it no longer matters, or a pass that stopped part way already
   * sent its delivery. Resolves to false when it should be delivered.
   */
  async function settled({
    owner,
    waiting,
    stale_before,
  }: {
    owner: PersonOwner;
    waiting: WaitingEvent;
    stale_before: Date;
  }): Promise<boolean> {
    if (!stillTimely({ event: waiting.event, now: now() })) {
      await stop({ owner, waiting, stale_before });
      return true;
    }
    if (waiting.status === 'delivering') {
      const made = await deps.history.get({ ...owner, id: waiting.delivery_id });
      if (made !== undefined && made.attempts.length > 0) {
        await store.settle({ ...owner, event_id: waiting.event.id, stale_before, status: 'raised' });
        return true;
      }
    }
    return false;
  }

  /** Raises every pending event of this watcher's kinds that no other pass is working on. */
  async function raisePending({
    owner,
    watcher,
    settings,
  }: {
    owner: PersonOwner;
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
    for (const waiting of pending) {
      const { event } = waiting;
      if (await settled({ owner, waiting, stale_before })) {
        continue;
      }
      const claim_id = newId();
      const claim = await store.claim({ ...owner, event_id: event.id, claim_id, now: now(), stale_before });
      if (claim === undefined) {
        continue;
      }
      try {
        const outcome = await raise({ owner, waiting, settings, claim_id, claim });
        if (outcome === 'raised') {
          raised += 1;
        } else if (outcome === 'busy') {
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

  /** One budget of time and calls for a mail pass, and the mail source counting against it. */
  function passBudget(): {
    spent: () => boolean;
    promotionSpent: () => boolean;
    counted: (source: MailSource) => MailSource;
  } {
    const started = now().getTime();
    let calls = 0;
    const spent = (): boolean => now().getTime() - started > MAIL_PASS_MS || calls >= MAIL_PASS_CALLS;
    return {
      spent,
      promotionSpent: () => spent() || now().getTime() - started > TRACKED_BILLS_MS || calls >= TRACKED_BILLS_CALLS,
      counted: (source: MailSource): MailSource => {
        const counting = {
          readText: (message: MailMessage) => {
            calls += 1;
            return source.readText(message);
          },
          // A thread check lists the thread and then fetches its messages.
          laterInThread: (ref: MailRef) => {
            calls += 2;
            return source.laterInThread(ref);
          },
        };
        if ('listAfter' in source) {
          return {
            ...source,
            ...counting,
            listAfter: input => {
              calls += 1;
              return source.listAfter(input);
            },
          };
        }
        return {
          ...source,
          ...counting,
          listNewMessages: async input => {
            calls += 1;
            const read = await source.listNewMessages(input);
            if (source.fetchesEachListed === true && read.read !== 'too_many') {
              calls += read.messages.length;
            }
            return read;
          },
        };
      },
    };
  }

  /**
   * The mail checkpoint. When it was written for another source, how far mail was read and the trouble since carry
   * over, so a switch never hides mail left unread; its counts and cursor mean nothing to this source.
   */
  async function checkpointFor({
    owner,
    kind,
  }: {
    owner: PersonOwner;
    kind: MailSourceKind;
  }): Promise<WatcherCheckpoint | undefined> {
    const stored = await store.getCheckpoint({ ...owner, watcher: 'mail' });
    return stored?.source === undefined || stored.source === kind
      ? stored
      : { ...stored, stuck: undefined, cursor: undefined, source: kind };
  }

  /** The name to put in a note; a lookup that fails never stops mail from being read. */
  async function assistantOf(owner: PersonOwner): Promise<string> {
    try {
      return await deps.assistantNameFor(owner);
    } catch (error) {
      logger.warn('Could not look up the assistant name; using the default', { error: errorText(error) });
      return UNNAMED_ASSISTANT;
    }
  }

  /**
   * One note for a whole stretch of trouble, however many passes leave mail unread in it: it is named by when the
   * trouble began, so later passes make the same note and a delivered one is not repeated.
   */
  function stretchNotes({
    gaps,
    began,
    ongoing,
    settings,
    assistant,
  }: {
    gaps: readonly LeftBehind[];
    /** When the trouble began, if it has. */
    began: Date | undefined;
    ongoing: boolean;
    settings: ReachSettings;
    assistant: string;
  }): NoticingEvent[] {
    if (gaps.length === 0) {
      return [];
    }
    const from = new Date(Math.min(...gaps.map(gap => gap.from.getTime())));
    const to = new Date(Math.max(...gaps.map(gap => gap.to.getTime())));
    const stretch = began ?? new Date(Math.floor(from.getTime() / 3_600_000) * 3_600_000);
    return [gapNote({ gap: { from, to }, stretch, ongoing, settings, assistant })];
  }

  async function runMail({
    owner,
    mail,
    kind,
    settings,
  }: {
    owner: PersonOwner;
    mail: MailSource;
    kind: MailSourceKind;
    settings: ReachSettings;
  }): Promise<void> {
    const budget = passBudget();
    const counted = budget.counted(mail);
    // Bills seen earlier still come due when new mail cannot be read, and are looked at first so a slow scan never
    // starves them.
    await promoteDueBills({ owner, mail: counted, now: now(), out_of_time: budget.promotionSpent }).catch(
      (error: unknown) => {
        logger.warn('Could not look at tracked bills', { error: errorText(error) });
      },
    );
    const at = now();
    const checkpoint = await checkpointFor({ owner, kind });
    // The checkpoint is where the next read starts. Mail is never read further back than a day.
    const oldest = new Date(at.getTime() - MAX_LOOKBACK_MS);
    const since = new Date(
      Math.max(checkpoint?.checked_at.getTime() ?? at.getTime() - FIRST_LOOKBACK_MS, oldest.getTime()),
    );
    const assistant = await assistantOf(owner);
    let findings: MailFindings;
    try {
      findings = await watchMail({
        source: counted,
        settings,
        since,
        now: at,
        logger,
        stuck: checkpoint?.stuck,
        // A cursor left from before the day limit would read the older mail too, so the read starts again at the limit.
        cursor:
          checkpoint !== undefined && checkpoint.checked_at.getTime() >= oldest.getTime()
            ? checkpoint.cursor
            : undefined,
        out_of_time: budget.spent,
        assistant,
      });
    } catch (error) {
      // Nothing was read, so the checkpoint stays where it was.
      await recordMailFailure({ owner, checkpoint, error, at, fallback: since, source: kind });
      throw error;
    }
    const moved = findings.resume_from === undefined || findings.resume_from.getTime() > since.getTime();
    // Mail from before the day limit is no longer read. It is told about once, when a pass reads past it.
    const dropped: LeftBehind[] =
      checkpoint !== undefined && moved && checkpoint.checked_at.getTime() < since.getTime()
        ? [{ from: checkpoint.checked_at, to: since }]
        : [];
    const failure =
      findings.resume_from === undefined && findings.stopped_by === undefined
        ? undefined
        : mailFailure({ checkpoint, error: findings.stopped_by?.error, timed_out: findings.timed_out, at });
    const notes = stretchNotes({
      gaps: [...findings.gaps, ...dropped],
      began: (failure ?? checkpoint?.failure)?.since,
      ongoing: failure !== undefined,
      settings,
      assistant,
    });
    await store.recordAll({ ...owner, events: [...findings.raise, ...notes], status: 'pending', now: at });
    await store.recordAll({ ...owner, events: findings.track, status: 'tracking', now: at });
    // Everything found is written down before the checkpoint moves, so a failed delivery is retried from the store.
    // A pass that read all mail up to now starts the next one a little earlier, for mail the server lists late. A
    // source that numbers its mail uses that time only after a renumbering, where its mail is named by Message-ID so
    // the earlier start lists nothing twice. Only such a pass clears the trouble. Any other leaves the mail read so
    // far behind the clock, which Reach me shows once it is far enough behind.
    await store.setCheckpoint({
      ...owner,
      watcher: 'mail',
      checked_at:
        findings.resume_from === undefined
          ? new Date(at.getTime() - CHECK_OVERLAP_MS)
          : moved
            ? findings.resume_from
            : (checkpoint?.checked_at ?? since),
      failure,
      stuck: findings.stuck,
      cursor: findings.cursor,
      source: kind,
    });
    if (findings.stopped_by !== undefined) {
      throw findings.stopped_by.error;
    }
  }

  /** Trouble the person can be told about starts when passes first leave mail unread and ends with a pass that reads to now. */
  function mailFailure({
    checkpoint,
    error,
    timed_out,
    at,
  }: {
    checkpoint: WatcherCheckpoint | undefined;
    error: unknown;
    timed_out: boolean;
    at: Date;
  }): NonNullable<WatcherCheckpoint['failure']> {
    const kind = (): MailProblemKind => {
      if (timed_out || error instanceof MailTooSlowError) {
        return 'too_slow';
      }
      if (causedBy({ error, matches: cause => cause instanceof GoogleReconnectRequiredError })) {
        return 'google_sign_in';
      }
      if (causedBy({ error, matches: cause => cause instanceof MailLoginFailedError })) {
        return 'email_password';
      }
      if (causedBy({ error, matches: cause => cause instanceof MailSourceBusyError })) {
        return 'too_slow';
      }
      return error === undefined ? (checkpoint?.failure?.kind ?? 'too_slow') : 'other';
    };
    return { kind: kind(), since: checkpoint?.failure?.since ?? at };
  }

  /** Writes that mail could not be read, leaving where reading starts next, and the message it is stuck on, as they were. */
  async function recordMailFailure({
    owner,
    checkpoint,
    error,
    at,
    fallback,
    source,
  }: {
    owner: PersonOwner;
    checkpoint: WatcherCheckpoint | undefined;
    error: unknown;
    at: Date;
    fallback: Date;
    source: MailSourceKind;
  }): Promise<void> {
    await store.setCheckpoint({
      ...owner,
      watcher: 'mail',
      checked_at: checkpoint?.checked_at ?? fallback,
      failure: mailFailure({ checkpoint, error, timed_out: false, at }),
      stuck: checkpoint?.stuck,
      cursor: checkpoint?.cursor,
      source,
    });
  }

  /**
   * Someone with no mail connected cannot have trouble checking it, so an old failure is not shown any more. Mail left
   * unread before then is told about once, since nothing will read it later.
   */
  async function clearMailTrouble({ owner, settings }: { owner: PersonOwner; settings: ReachSettings }): Promise<void> {
    const checkpoint = await store.getCheckpoint({ ...owner, watcher: 'mail' });
    if (checkpoint === undefined) {
      return;
    }
    const at = now();
    // Mail from a source that has gone away is unread since the last pass, so it is told about once. The place then
    // belongs to no source, so the next pass with none finds nothing more to tell.
    if (
      checkpoint.source !== undefined ||
      checkpoint.failure !== undefined ||
      at.getTime() - checkpoint.checked_at.getTime() >= MAIL_PROBLEM_SHOWN_AFTER_MS
    ) {
      const from = new Date(Math.max(checkpoint.checked_at.getTime(), at.getTime() - MAX_LOOKBACK_MS));
      const notes = stretchNotes({
        gaps: [{ from, to: at }],
        began: checkpoint.failure?.since,
        ongoing: false,
        settings,
        assistant: await assistantOf(owner),
      });
      await store.recordAll({ ...owner, events: notes, status: 'pending', now: at });
    }
    await store.setCheckpoint({
      ...owner,
      watcher: 'mail',
      ...checkpoint,
      checked_at: at,
      failure: undefined,
      stuck: undefined,
      cursor: undefined,
      source: undefined,
    });
  }

  /**
   * Bills seen earlier that now fall due within three days become pending, unless something since says they were paid.
   * A bill whose thread cannot be checked is left for the next pass until it is close to due, then raised.
   */
  async function promoteDueBills({
    owner,
    mail,
    now: at,
    out_of_time,
  }: {
    owner: PersonOwner;
    /** Undefined when mail cannot be reached, so no thread is read and bills close to due are raised unchecked. */
    mail: MailSource | undefined;
    now: Date;
    out_of_time: () => boolean;
  }) {
    const due = await store.listTracking({
      ...owner,
      due_before: new Date(at.getTime() + BILL_WINDOW_MS),
      limit: TRACKING_LIMIT,
    });
    for (const event of due) {
      const deadline = event.due_at === null ? undefined : new Date(event.due_at);
      // A thread that can never be read cannot say the bill was paid, so the bill is raised. With no time left the
      // thread is not read, so a bill close to due is still raised and the rest wait for the next pass.
      const paid =
        mail === undefined || out_of_time()
          ? undefined
          : await billIsPaid({ source: mail, event }).catch((error: unknown) => {
              if (error instanceof MessageUnreadableError) {
                return false;
              }
              logger.warn('Could not check whether a tracked bill was paid', {
                event_id: event.id,
                error: errorText(error),
              });
              return undefined;
            });
      if (deadline === undefined || deadline.getTime() < at.getTime() || paid === true) {
        await store.drop({ ...owner, event_id: event.id });
      } else if (paid === false || deadline.getTime() - at.getTime() <= UNCHECKED_BILL_RAISED_WITHIN_MS) {
        await store.promote({ ...owner, event_id: event.id });
      }
    }
  }

  async function runCalendar({
    owner,
    calendar,
    settings,
  }: {
    owner: PersonOwner;
    calendar: CalendarSource;
    settings: ReachSettings;
  }): Promise<void> {
    const at = now();
    let events: NoticingEvent[];
    try {
      events = await watchCalendar({ source: calendar, settings, now: at });
    } catch (error) {
      // The calendar is read from now on, so a failed pass loses nothing; the person is told once it lasts. What the
      // calendar answered is kept out of the logs.
      await recordCalendarFailure({ owner, kind: 'other', at });
      throw new Error('The calendar could not be read.', { cause: error });
    }
    await store.recordAll({ ...owner, events, status: 'pending', now: at });
    await store.setCheckpoint({
      ...owner,
      watcher: 'calendar',
      checked_at: at,
      failure: undefined,
      stuck: undefined,
      source: undefined,
    });
  }

  async function recordCalendarFailure({
    owner,
    kind,
    at,
  }: {
    owner: PersonOwner;
    kind: CalendarProblemKind;
    at: Date;
  }): Promise<void> {
    const checkpoint = await store.getCheckpoint({ ...owner, watcher: 'calendar' });
    await store.setCheckpoint({
      ...owner,
      watcher: 'calendar',
      checked_at: checkpoint?.checked_at ?? at,
      failure: { kind, since: checkpoint?.failure?.since ?? at },
      stuck: undefined,
      source: undefined,
    });
  }

  /** Someone with no calendar connected cannot have trouble checking it, so an old failure is not shown any more. */
  async function clearCalendarTrouble(owner: PersonOwner): Promise<void> {
    const checkpoint = await store.getCheckpoint({ ...owner, watcher: 'calendar' });
    if (checkpoint?.failure !== undefined) {
      await store.setCheckpoint({
        ...owner,
        watcher: 'calendar',
        ...checkpoint,
        checked_at: now(),
        failure: undefined,
      });
    }
  }

  /**
   * Records one person's open requests that waited long enough, and drops any recorded request that is no longer
   * open, so a request answered in the meantime is never raised.
   */
  async function runApprovals({
    owner,
    waiting,
    settings,
  }: {
    owner: PersonOwner;
    waiting: readonly WaitingApproval[];
    settings: ReachSettings;
  }): Promise<void> {
    const events = watchApprovals({ waiting, settings, now: now() });
    await store.recordAll({ ...owner, events, status: 'pending', now: now() });
    const open = new Set(waiting.map(item => `approval_waiting:${item.session_id}:${item.approval_id}`));
    const stale_before = new Date(now().getTime() - CLAIM_STALE_MS);
    const recorded = await store.listPending({
      ...owner,
      kinds: WATCHER_KINDS.approvals,
      stale_before,
      limit: PENDING_LIMIT,
    });
    for (const item of recorded.filter(entry => !open.has(entry.event.id))) {
      await stop({ owner, waiting: item, stale_before });
    }
  }

  /**
   * Who a pass looks at. Mail and calendar: everyone with a source or saved settings. Approvals: everyone with an
   * open request, whether or not they ever connected anything, with their requests.
   */
  async function ownersToWatch(
    watcher: NoticingWatcher,
  ): Promise<{ owners: PersonOwner[]; approvals: Map<string, WaitingApproval[]> }> {
    const approvals = new Map<string, WaitingApproval[]>();
    if (watcher === 'approvals') {
      for (const item of await deps.approvals.listWaiting()) {
        const key = ownerKey(item.owner);
        approvals.set(key, [...(approvals.get(key) ?? []), item]);
      }
      const owners = [...approvals.values()].flatMap(items => (items[0] === undefined ? [] : [items[0].owner]));
      return { owners, approvals };
    }
    // A person who lost their source or never saved settings is still looked at while they have a checkpoint, so mail
    // left unread is told about and trouble is kept.
    const listed = [
      ...(await deps.sources.listOwners()),
      ...(await deps.reachSettings.listOwners()),
      ...(await store.listCheckpointOwners({ watcher })),
    ];
    const seen = new Set<string>();
    const owners = listed.filter(owner => {
      const key = ownerKey(owner);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    return { owners, approvals };
  }

  async function look({
    owner,
    watcher,
    settings,
    waiting,
  }: {
    owner: PersonOwner;
    watcher: NoticingWatcher;
    settings: ReachSettings;
    waiting: readonly WaitingApproval[];
  }): Promise<void> {
    if (watcher === 'approvals') {
      await runApprovals({ owner, waiting, settings });
      return;
    }
    const sources = await deps.sources.sourcesFor(owner);
    if (watcher === 'mail') {
      const { mail } = sources;
      if (mail.status === 'ready') {
        await runMail({ owner, mail: mail.source, kind: mail.kind, settings });
      } else if (mail.status === 'none') {
        await clearMailTrouble({ owner, settings });
      } else {
        // A mail source that is set up but out of reach is trouble the person can see, not no mail at all. Bills
        // already tracked still come due, so those close to it are raised without reading their threads.
        const at = now();
        await promoteDueBills({ owner, mail: undefined, now: at, out_of_time: () => true }).catch((error: unknown) => {
          logger.warn('Could not look at tracked bills', { error: errorText(error) });
        });
        // The place mail was read to stays where it is, whatever source it was read from, so the lag keeps showing.
        const stored = await store.getCheckpoint({ ...owner, watcher: 'mail' });
        await recordMailFailure({
          owner,
          checkpoint: stored,
          error: mail.error,
          at,
          fallback: new Date(at.getTime() - FIRST_LOOKBACK_MS),
          source: stored?.source ?? mail.kind,
        });
      }
    }
    if (watcher === 'calendar') {
      const { calendar } = sources;
      if (calendar.status === 'ready') {
        await runCalendar({ owner, calendar: calendar.source, settings });
      } else if (calendar.status === 'none') {
        await clearCalendarTrouble(owner);
      } else {
        await recordCalendarFailure({ owner, kind: calendar.kind, at: now() });
      }
    }
  }

  return {
    async run({ watcher }) {
      if (watcher === 'approvals') {
        // A request closes itself once it expires, so a waiting one recorded before then is dropped for everyone,
        // including people with no open request left for a pass to look at.
        await store.dropStale({
          kinds: WATCHER_KINDS.approvals,
          created_before: new Date(now().getTime() - APPROVAL_EXPIRY_MINUTES * 60_000),
        });
      }
      const { owners, approvals } = await ownersToWatch(watcher);
      let raised = 0;
      for (const owner of owners) {
        try {
          const settings = (await deps.reachSettings.get(owner)) ?? defaultReachSettings(await deps.timezoneFor(owner));
          // With the checks off nothing is opened, read or asked: no source, no model and no delivery. What earlier
          // passes stored, tracked bills and the place mail was read to among them, waits as it is.
          if (!settings.noticing_on) {
            continue;
          }
          try {
            await look({ owner, watcher, settings, waiting: approvals.get(ownerKey(owner)) ?? [] });
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
