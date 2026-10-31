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
}

/** What the sender needs to reach one device. */
export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface IPushSubscriptionStore {
  /**
   * Saves a device. A device already saved keeps one row and moves to the latest person who turned notices on, so a
   * shared browser never keeps sending the earlier person's items.
   */
  save(input: SavePushSubscriptionInput): Promise<PushSubscriptionInfo>;
  listTargets(input: PushOwner): Promise<PushTarget[]>;
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

  async save(input: SavePushSubscriptionInput): Promise<PushSubscriptionInfo> {
    const row = await this.#db
      .insertInto('push_subscription')
      .values({
        id: newId(),
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        label: input.label,
        created_at: new Date().toISOString(),
      })
      .onConflict(conflict =>
        conflict.column('endpoint').doUpdateSet({
          tenant_id: input.tenant_id,
          created_by: input.created_by,
          p256dh: input.p256dh,
          auth: input.auth,
          label: input.label,
        }),
      )
      .returning(['id', 'label', 'created_at'])
      .executeTakeFirstOrThrow();
    return { id: row.id, label: row.label, created_at: toIso(row.created_at) };
  }

  async listTargets(input: PushOwner): Promise<PushTarget[]> {
    return this.#db
      .selectFrom('push_subscription')
      .select(['id', 'endpoint', 'p256dh', 'auth'])
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
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
