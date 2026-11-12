import type { Kysely } from 'kysely';

import type { PushSubscriptionInfo } from '../schemas/deliveries';
import { newId } from '../utils/id';

/** One row of `push_subscription`: one browser or phone that turned notices on. It belongs to the device, not to a data export. */
export interface PushSubscriptionTable {
  id: string;
  tenant_id: string;
  created_by: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  /** The server's public key when the device turned notices on. A device on another key cannot be reached. */
  server_key: string;
  created_at: string | Date;
}

export interface PushSubscriptionDatabase {
  push_subscription: PushSubscriptionTable;
}

interface PushOwner {
  tenant_id: string;
  created_by: string;
}

export interface SavePushSubscriptionInput extends PushOwner {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  server_key: string;
}

/** Most devices one person keeps notices on for. Turning on one more drops the one turned on longest ago. */
export const MAX_PUSH_DEVICES = 10;

/** `taken` when the device's address already belongs to another person, who keeps it. */
export type SavePushSubscriptionResult =
  { outcome: 'saved'; subscription: PushSubscriptionInfo } | { outcome: 'taken' };

/** What the sender needs to reach one device. */
export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  server_key: string;
}

export interface IPushSubscriptionStore {
  /**
   * Saves a device for its owner and keeps their newest MAX_PUSH_DEVICES. An address another person saved is never
   * moved; the browser makes a fresh subscription instead.
   */
  save(input: SavePushSubscriptionInput): Promise<SavePushSubscriptionResult>;
  /** The owner's devices, at most MAX_PUSH_DEVICES. */
  listTargets(input: PushOwner): Promise<PushTarget[]>;
  /** Whether the owner still has a device with this address. */
  hasEndpoint(input: PushOwner & { endpoint: string }): Promise<boolean>;
  /** Removes the owner's device with this address. Resolves to whether one was removed. */
  removeByEndpoint(input: PushOwner & { endpoint: string }): Promise<boolean>;
  /** Removes a device the push service said is gone. */
  removeById(input: PushOwner & { id: string }): Promise<boolean>;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export class PushSubscriptionStore implements IPushSubscriptionStore {
  readonly #db: Kysely<PushSubscriptionDatabase>;

  constructor(db: Kysely<PushSubscriptionDatabase>) {
    this.#db = db;
  }

  async save(input: SavePushSubscriptionInput): Promise<SavePushSubscriptionResult> {
    return this.#db.transaction().execute(async trx => {
      const now = new Date().toISOString();
      const row = await trx
        .insertInto('push_subscription')
        .values({
          id: newId(),
          tenant_id: input.tenant_id,
          created_by: input.created_by,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          label: input.label,
          server_key: input.server_key,
          created_at: now,
        })
        .onConflict(conflict =>
          conflict
            .column('endpoint')
            .doUpdateSet({
              p256dh: input.p256dh,
              auth: input.auth,
              label: input.label,
              server_key: input.server_key,
              created_at: now,
            })
            .where('push_subscription.tenant_id', '=', input.tenant_id)
            .where('push_subscription.created_by', '=', input.created_by),
        )
        .returning(['id', 'label', 'created_at'])
        .executeTakeFirst();
      if (row === undefined) {
        return { outcome: 'taken' };
      }
      const kept = await trx
        .selectFrom('push_subscription')
        .select('id')
        .where('tenant_id', '=', input.tenant_id)
        .where('created_by', '=', input.created_by)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(MAX_PUSH_DEVICES)
        .execute();
      await trx
        .deleteFrom('push_subscription')
        .where('tenant_id', '=', input.tenant_id)
        .where('created_by', '=', input.created_by)
        .where(
          'id',
          'not in',
          kept.map(keep => keep.id),
        )
        .execute();
      return { outcome: 'saved', subscription: { id: row.id, label: row.label, created_at: toIso(row.created_at) } };
    });
  }

  async listTargets(input: PushOwner): Promise<PushTarget[]> {
    return this.#db
      .selectFrom('push_subscription')
      .select(['id', 'endpoint', 'p256dh', 'auth', 'server_key'])
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(MAX_PUSH_DEVICES)
      .execute();
  }

  async hasEndpoint(input: PushOwner & { endpoint: string }): Promise<boolean> {
    const row = await this.#db
      .selectFrom('push_subscription')
      .select('id')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('endpoint', '=', input.endpoint)
      .executeTakeFirst();
    return row !== undefined;
  }

  async removeByEndpoint(input: PushOwner & { endpoint: string }): Promise<boolean> {
    const rows = await this.#db
      .deleteFrom('push_subscription')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('endpoint', '=', input.endpoint)
      .returning('id')
      .execute();
    return rows.length > 0;
  }

  async removeById(input: PushOwner & { id: string }): Promise<boolean> {
    const rows = await this.#db
      .deleteFrom('push_subscription')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('id', '=', input.id)
      .returning('id')
      .execute();
    return rows.length > 0;
  }
}
