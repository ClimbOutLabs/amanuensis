import type { ExpressionBuilder, Kysely } from 'kysely';

import {
  MailProblemKindSchema,
  MailSourceKindSchema,
  NoticingEventSchema,
  NoticingVerdictSchema,
  type MailProblemKind,
  type MailSourceKind,
  type NoticingEvent,
  type NoticingKind,
  type NoticingVerdict,
  type NoticingWatcher,
} from '../schemas/reach';
import { newId } from '../utils/id';

import type { PersonOwner } from './personOwner';

/**
 * Rows of `noticing_event`: one per stable event id. `tracking` waits for a due date, `pending` waits to be raised,
 * `delivering` is being delivered, `raised` was delivered, `dropped` will never be raised and `failed` stopped after
 * too many tries. A pending or delivering row is worked on by whoever holds its `claim_id`; a claim older than the
 * caller's stale mark is free to take. `verdict_json` keeps the model's answer, so a retry never asks again.
 * `delivery_id` is drawn at random when the event is first written, so every try makes the same delivery and no one
 * else can know it.
 */
export interface NoticingEventTable {
  id: string;
  tenant_id: string;
  created_by: string;
  event_id: string;
  kind: string;
  status: string;
  /** JSON of a NoticingEvent. */
  event_json: string;
  due_at: string | Date | null;
  verdict_json: string | null;
  delivery_id: string;
  created_at: string | Date;
  claim_id: string | null;
  claimed_at: string | Date | null;
  attempts: number;
}

/**
 * The IMAP cursor is kept as `<uidvalidity>:<last_uid>`, followed by `:<to_uid>:<since in ms>` while some of the mail
 * is still to be dated; anything else reads as no cursor.
 */
function parseCursor(stored: string | null): MailCursor | undefined {
  const match = /^(\d+):(\d+)(?::(\d+):(\d+))?$/.exec(stored ?? '');
  if (match === null) {
    return undefined;
  }
  const [, uidvalidity, last_uid, to_uid, since] = match;
  return {
    uidvalidity: Number(uidvalidity),
    last_uid: Number(last_uid),
    dated:
      to_uid === undefined || since === undefined
        ? undefined
        : { to_uid: Number(to_uid), since: new Date(Number(since)) },
  };
}

function storedCursor(cursor: MailCursor): string {
  const dated =
    cursor.dated === undefined ? '' : `:${String(cursor.dated.to_uid)}:${String(cursor.dated.since.getTime())}`;
  return `${String(cursor.uidvalidity)}:${String(cursor.last_uid)}${dated}`;
}

/**
 * When a watcher last looked for one person, and how it is doing. `failing_since` and `failure_kind` are set while
 * passes keep failing and cleared by a pass that works. `stuck_*` name the one message a pass keeps failing on and how
 * many passes failed on it and since when, so a message that never reads can be passed over. `imap_cursor` is the last
 * message of an IMAP mailbox that was read or passed over, with the mailbox's UIDVALIDITY. `source` is where mail was
 * read from.
 */
export interface NoticingCheckpointTable {
  tenant_id: string;
  created_by: string;
  watcher: string;
  checked_at: string | Date;
  failing_since: string | Date | null;
  failure_kind: string | null;
  stuck_message_id: string | null;
  stuck_passes: number;
  stuck_since: string | Date | null;
  imap_cursor: string | null;
  source: string | null;
}

/** Who is deciding how loudly to reach one person right now, and until when. */
export interface ReachLeaseTable {
  tenant_id: string;
  created_by: string;
  holder: string;
  held_until: string | Date;
}

export interface NoticingDatabase {
  noticing_event: NoticingEventTable;
  noticing_checkpoint: NoticingCheckpointTable;
  reach_lease: ReachLeaseTable;
}

/** What a pass holds once it claimed an event: the model's answer when an earlier try already had one. */
export interface NoticingClaim {
  verdict: NoticingVerdict | null;
}

/**
 * An event waiting to be raised. `delivering` means a pass stopped part way through delivering it, so its delivery
 * may already be made under `delivery_id`.
 */
export interface WaitingEvent {
  event: NoticingEvent;
  status: 'pending' | 'delivering';
  delivery_id: string;
}

/**
 * An event claimed this many times without being delivered is given up on, so one broken event never blocks a pass
 * for good. A pass that stopped without handing the event back counts too.
 */
const MAX_ATTEMPTS = 5;

/** Events a pass may claim: waiting to be raised, or left halfway through delivery by a pass that stopped. */
const WAITING = ['pending', 'delivering'];

/**
 * What a watcher keeps stopping at, how many passes in a row failed on it, and when it first did. `message_id` is a
 * message, or for a stretch of mail that cannot be listed `list:` and the time it starts at, so nothing may read it as
 * a message id.
 */
export interface StuckMessage {
  message_id: string;
  passes: number;
  since: Date;
}

/** A mailbox's UIDVALIDITY and the highest message UID that was read or passed over. */
export interface MailCursor {
  uidvalidity: number;
  last_uid: number;
  /**
   * While a listing by time is not finished: the UIDs up to `to_uid` were in the mailbox when it began, so each one
   * counts only if it arrived at or after `since`.
   */
  dated?: { to_uid: number; since: Date } | undefined;
}

/** Where a watcher reads from next, and its trouble if passes keep failing. */
export interface WatcherCheckpoint {
  checked_at: Date;
  failure: { kind: MailProblemKind; since: Date } | undefined;
  stuck: StuckMessage | undefined;
  /** Where IMAP mail was read to, so the next pass starts at the next message. */
  cursor?: MailCursor | undefined;
  source: MailSourceKind | undefined;
}

export interface INoticingStore {
  /**
   * Writes each event the first time its stable id is seen, either `pending` to be raised or `tracking` to wait for
   * its due date. An event already written is left as it is.
   */
  recordAll(
    input: PersonOwner & { events: readonly NoticingEvent[]; status: 'pending' | 'tracking'; now: Date },
  ): Promise<void>;
  /** Pending or interrupted events of these kinds that no live claim holds, oldest first. */
  listPending(
    input: PersonOwner & { kinds: readonly NoticingKind[]; stale_before: Date; limit: number },
  ): Promise<WaitingEvent[]>;
  /**
   * Takes an event for one pass, counting the try. Resolves to undefined when another live claim holds it, it is not
   * waiting, or it has been tried too often, in which case it is marked failed.
   */
  claim(
    input: PersonOwner & { event_id: string; claim_id: string; now: Date; stale_before: Date },
  ): Promise<NoticingClaim | undefined>;
  /** Keeps the model's answer with the claimed event, so a later try uses it instead of asking again. */
  saveVerdict(input: PersonOwner & { event_id: string; claim_id: string; verdict: NoticingVerdict }): Promise<void>;
  /** Marks a claimed event as being delivered. Resolves to false when another pass took the claim first. */
  startDelivering(input: PersonOwner & { event_id: string; claim_id: string; now: Date }): Promise<boolean>;
  /** Marks an event that was being delivered as raised, with the delivery that was made. */
  finish(input: PersonOwner & { event_id: string; claim_id: string; delivery_id: string }): Promise<void>;
  /**
   * Closes an event a pass left part way through delivering, when no live claim holds it: `raised` when its delivery
   * was made, `dropped` when it was not and it no longer matters.
   */
  settle(input: PersonOwner & { event_id: string; stale_before: Date; status: 'raised' | 'dropped' }): Promise<void>;
  /**
   * Hands a claimed event back for a later pass. A try that only waited for another pass (`failed: false`) is not
   * counted. Resolves to the status the event is left in.
   */
  release(input: PersonOwner & { event_id: string; claim_id: string; failed: boolean }): Promise<'pending' | 'failed'>;
  /** Tracked events due at or before `due_before`, soonest first. */
  listTracking(input: PersonOwner & { due_before: Date; limit: number }): Promise<NoticingEvent[]>;
  /** Moves a tracked event to pending, when it is still tracked. */
  promote(input: PersonOwner & { event_id: string }): Promise<void>;
  /**
   * Drops every person's pending events of these kinds recorded before `created_before`, for events that cannot
   * matter any more once that old, even for someone no pass looks at again. One left part way through delivering is
   * left for `settle`, since its delivery may have gone out.
   */
  dropStale(input: { kinds: readonly NoticingKind[]; created_before: Date }): Promise<void>;
  /**
   * Stops an event that is tracked or pending and will never be raised (it passed, or was paid). One being delivered
   * is left for `settle`.
   */
  drop(input: PersonOwner & { event_id: string }): Promise<void>;
  /** Takes the person's reach lease when it is free or ran out. Resolves to false while someone else holds it. */
  acquireReachLease(input: PersonOwner & { holder: string; now: Date; until: Date }): Promise<boolean>;
  /** Hands the lease back, when this holder still has it. */
  releaseReachLease(input: PersonOwner & { holder: string }): Promise<void>;
  getCheckpoint(input: PersonOwner & { watcher: NoticingWatcher }): Promise<WatcherCheckpoint | undefined>;
  /** Everyone with a checkpoint for a watcher, so someone who lost their source is still looked at once. */
  listCheckpointOwners(input: { watcher: NoticingWatcher }): Promise<PersonOwner[]>;
  /** Replaces the whole checkpoint, so a pass that works clears an earlier failure by leaving it out. */
  setCheckpoint(input: PersonOwner & { watcher: NoticingWatcher } & WatcherCheckpoint): Promise<void>;
}

function eventOf(row: Pick<NoticingEventTable, 'event_json'>): NoticingEvent {
  return NoticingEventSchema.parse(JSON.parse(row.event_json));
}

/** The events the watchers found and how each was decided. Owner-scoped. */
export class NoticingStore implements INoticingStore {
  readonly #db: Kysely<NoticingDatabase>;

  constructor(db: Kysely<NoticingDatabase>) {
    this.#db = db;
  }

  async recordAll(
    input: PersonOwner & { events: readonly NoticingEvent[]; status: 'pending' | 'tracking'; now: Date },
  ): Promise<void> {
    if (input.events.length === 0) {
      return;
    }
    const created_at = input.now.toISOString();
    const rows = input.events.map(item => {
      const event = NoticingEventSchema.parse(item);
      return {
        id: newId(),
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        event_id: event.id,
        kind: event.kind,
        status: input.status,
        event_json: JSON.stringify(event),
        due_at: event.due_at,
        verdict_json: null,
        delivery_id: newId(),
        created_at,
        claim_id: null,
        claimed_at: null,
        attempts: 0,
      };
    });
    await this.#db
      .insertInto('noticing_event')
      .values(rows)
      .onConflict(conflict => conflict.columns(['tenant_id', 'created_by', 'event_id']).doNothing())
      .execute();
  }

  async listPending(
    input: PersonOwner & { kinds: readonly NoticingKind[]; stale_before: Date; limit: number },
  ): Promise<WaitingEvent[]> {
    if (input.kinds.length === 0) {
      return [];
    }
    const stale = input.stale_before.toISOString();
    const rows = await this.#db
      .selectFrom('noticing_event')
      .select(['event_json', 'status', 'delivery_id'])
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('status', 'in', WAITING)
      .where('kind', 'in', [...input.kinds])
      .where(eb => eb.or([eb('claimed_at', 'is', null), eb('claimed_at', '<', stale)]))
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(input.limit)
      .execute();
    return rows.map(row => ({
      event: eventOf(row),
      status: row.status === 'delivering' ? 'delivering' : 'pending',
      delivery_id: row.delivery_id,
    }));
  }

  async claim(
    input: PersonOwner & { event_id: string; claim_id: string; now: Date; stale_before: Date },
  ): Promise<NoticingClaim | undefined> {
    const stale = input.stale_before.toISOString();
    const free = (eb: ExpressionBuilder<NoticingDatabase, 'noticing_event'>) =>
      eb.or([eb('claimed_at', 'is', null), eb('claimed_at', '<', stale)]);
    const taken = await this.#db
      .updateTable('noticing_event')
      .set(eb => ({ claim_id: input.claim_id, claimed_at: input.now.toISOString(), attempts: eb('attempts', '+', 1) }))
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('status', 'in', WAITING)
      .where('attempts', '<', MAX_ATTEMPTS)
      .where(free)
      .returning('verdict_json')
      .executeTakeFirst();
    if (taken !== undefined) {
      return {
        verdict: taken.verdict_json === null ? null : NoticingVerdictSchema.parse(JSON.parse(taken.verdict_json)),
      };
    }
    await this.#db
      .updateTable('noticing_event')
      .set({ status: 'failed', claim_id: null, claimed_at: null })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('status', 'in', WAITING)
      .where('attempts', '>=', MAX_ATTEMPTS)
      .where(free)
      .execute();
    return undefined;
  }

  async saveVerdict(
    input: PersonOwner & { event_id: string; claim_id: string; verdict: NoticingVerdict },
  ): Promise<void> {
    await this.#db
      .updateTable('noticing_event')
      .set({ verdict_json: JSON.stringify(NoticingVerdictSchema.parse(input.verdict)) })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('claim_id', '=', input.claim_id)
      .execute();
  }

  async startDelivering(input: PersonOwner & { event_id: string; claim_id: string; now: Date }): Promise<boolean> {
    const updated = await this.#db
      .updateTable('noticing_event')
      .set({ status: 'delivering', claimed_at: input.now.toISOString() })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('status', 'in', WAITING)
      .where('claim_id', '=', input.claim_id)
      .returning('id')
      .execute();
    return updated.length > 0;
  }

  async finish(input: PersonOwner & { event_id: string; claim_id: string; delivery_id: string }): Promise<void> {
    await this.#db
      .updateTable('noticing_event')
      .set({ status: 'raised', delivery_id: input.delivery_id, claim_id: null, claimed_at: null })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('status', '=', 'delivering')
      .where('claim_id', '=', input.claim_id)
      .execute();
  }

  async settle(
    input: PersonOwner & { event_id: string; stale_before: Date; status: 'raised' | 'dropped' },
  ): Promise<void> {
    const stale = input.stale_before.toISOString();
    await this.#db
      .updateTable('noticing_event')
      .set({ status: input.status, claim_id: null, claimed_at: null })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('status', '=', 'delivering')
      .where(eb => eb.or([eb('claimed_at', 'is', null), eb('claimed_at', '<', stale)]))
      .execute();
  }

  async release(
    input: PersonOwner & { event_id: string; claim_id: string; failed: boolean },
  ): Promise<'pending' | 'failed'> {
    const left = await this.#db
      .updateTable('noticing_event')
      .set(eb => ({
        // The try was counted when it was claimed; one that only waited for another pass is taken back.
        attempts: input.failed ? eb.ref('attempts') : eb('attempts', '-', 1),
        status: input.failed
          ? eb.case().when('attempts', '>=', MAX_ATTEMPTS).then('failed').else('pending').end()
          : 'pending',
        claim_id: null,
        claimed_at: null,
      }))
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('status', 'in', WAITING)
      .where('claim_id', '=', input.claim_id)
      .returning('status')
      .executeTakeFirst();
    return left?.status === 'failed' ? 'failed' : 'pending';
  }

  async listTracking(input: PersonOwner & { due_before: Date; limit: number }): Promise<NoticingEvent[]> {
    const rows = await this.#db
      .selectFrom('noticing_event')
      .select('event_json')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('status', '=', 'tracking')
      .where('due_at', '<=', input.due_before.toISOString())
      .orderBy('due_at', 'asc')
      .orderBy('id', 'asc')
      .limit(input.limit)
      .execute();
    return rows.map(eventOf);
  }

  async promote(input: PersonOwner & { event_id: string }): Promise<void> {
    await this.#db
      .updateTable('noticing_event')
      .set({ status: 'pending' })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('status', '=', 'tracking')
      .execute();
  }

  async dropStale(input: { kinds: readonly NoticingKind[]; created_before: Date }): Promise<void> {
    if (input.kinds.length === 0) {
      return;
    }
    await this.#db
      .updateTable('noticing_event')
      .set({ status: 'dropped', claim_id: null, claimed_at: null })
      .where('kind', 'in', [...input.kinds])
      .where('status', '=', 'pending')
      .where('created_at', '<', input.created_before.toISOString())
      .execute();
  }

  async drop(input: PersonOwner & { event_id: string }): Promise<void> {
    await this.#db
      .updateTable('noticing_event')
      .set({ status: 'dropped', claim_id: null, claimed_at: null })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('event_id', '=', input.event_id)
      .where('status', 'in', ['tracking', 'pending'])
      .execute();
  }

  async acquireReachLease(input: PersonOwner & { holder: string; now: Date; until: Date }): Promise<boolean> {
    const held_until = input.until.toISOString();
    const taken = await this.#db
      .insertInto('reach_lease')
      .values({ tenant_id: input.tenant_id, created_by: input.created_by, holder: input.holder, held_until })
      .onConflict(conflict =>
        conflict
          .columns(['tenant_id', 'created_by'])
          .doUpdateSet({ holder: input.holder, held_until })
          .where('reach_lease.held_until', '<', input.now.toISOString()),
      )
      .returning('holder')
      .execute();
    return taken.length > 0;
  }

  async releaseReachLease(input: PersonOwner & { holder: string }): Promise<void> {
    await this.#db
      .deleteFrom('reach_lease')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('holder', '=', input.holder)
      .execute();
  }

  async getCheckpoint(input: PersonOwner & { watcher: NoticingWatcher }): Promise<WatcherCheckpoint | undefined> {
    const row = await this.#db
      .selectFrom('noticing_checkpoint')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('watcher', '=', input.watcher)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    const kind = MailProblemKindSchema.safeParse(row.failure_kind);
    const source = MailSourceKindSchema.safeParse(row.source);
    return {
      checked_at: new Date(row.checked_at),
      failure:
        row.failing_since === null || !kind.success
          ? undefined
          : { kind: kind.data, since: new Date(row.failing_since) },
      stuck:
        row.stuck_message_id === null
          ? undefined
          : {
              message_id: row.stuck_message_id,
              passes: row.stuck_passes,
              since: new Date(row.stuck_since ?? row.checked_at),
            },
      cursor: parseCursor(row.imap_cursor),
      source: source.success ? source.data : undefined,
    };
  }

  async listCheckpointOwners(input: { watcher: NoticingWatcher }): Promise<PersonOwner[]> {
    return await this.#db
      .selectFrom('noticing_checkpoint')
      .select(['tenant_id', 'created_by'])
      .where('watcher', '=', input.watcher)
      .execute();
  }

  async setCheckpoint(input: PersonOwner & { watcher: NoticingWatcher } & WatcherCheckpoint): Promise<void> {
    const state = {
      checked_at: input.checked_at.toISOString(),
      failing_since: input.failure?.since.toISOString() ?? null,
      failure_kind: input.failure?.kind ?? null,
      stuck_message_id: input.stuck?.message_id ?? null,
      stuck_passes: input.stuck?.passes ?? 0,
      stuck_since: input.stuck?.since.toISOString() ?? null,
      imap_cursor: input.cursor === undefined ? null : storedCursor(input.cursor),
      source: input.source ?? null,
    };
    await this.#db
      .insertInto('noticing_checkpoint')
      .values({ tenant_id: input.tenant_id, created_by: input.created_by, watcher: input.watcher, ...state })
      .onConflict(conflict => conflict.columns(['tenant_id', 'created_by', 'watcher']).doUpdateSet(state))
      .execute();
  }
}
