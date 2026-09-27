/**
 * Notifications server adapter — maps runtime Notification DTOs to the
 * `/api/v1/notifications` HTTP endpoints via direct fetch.
 *
 * Uses direct fetch rather than the generated SDK client because the SDK
 * has not yet been regenerated with the notification endpoints.
 * TODO: migrate to the generated SDK client once it declares them, and drop
 * the hand-rolled request/parsing helpers below.
 */
import type {
  ListNotificationsParams,
  ListResult,
  Notification,
  NotificationsServer,
} from '../../../server/types.js';
import { resolveTrueForgeBaseUrl, type CreateTrueForgeClientOptions } from '../client.js';

const NOTIFICATIONS_PAGE_LIMIT = 25;

interface WireNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  schedule_id?: string | null;
  schedule_run_id?: string | null;
  read_at: string | null;
  created_at: string;
  updated_at: string;
  created_by_subject?: {
    subject_id: string;
    subject_type: string;
    subject_display_name: string;
  };
}

function toUiNotification(wire: WireNotification): Notification {
  const kind = wire.kind;
  if (kind !== 'reminder' && kind !== 'briefing' && kind !== 'schedule_complete' && kind !== 'schedule_failed') {
    throw new Error(`Unknown notification kind: ${kind}`);
  }
  const createdBy = wire.created_by_subject;
  return {
    id: wire.id,
    kind,
    title: wire.title,
    body: wire.body,
    scheduleId: wire.schedule_id ?? null,
    scheduleRunId: wire.schedule_run_id ?? null,
    readAt: wire.read_at,
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
    createdBySubject: createdBy === undefined ? undefined : {
      subjectId: createdBy.subject_id,
      subjectType: createdBy.subject_type,
      subjectDisplayName: createdBy.subject_display_name,
    },
  };
}

/** Validate the wire shape from the notifications API. */
function parseWireNotification(value: unknown): WireNotification {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid notification');
  }
  const id = 'id' in value ? value.id : undefined;
  const kind = 'kind' in value ? value.kind : undefined;
  const title = 'title' in value ? value.title : undefined;
  const body = 'body' in value ? value.body : undefined;
  const created_at = 'created_at' in value ? value.created_at : undefined;
  const updated_at = 'updated_at' in value ? value.updated_at : undefined;
  const read_at = 'read_at' in value ? value.read_at : undefined;
  const schedule_id = 'schedule_id' in value ? value.schedule_id : undefined;
  const schedule_run_id = 'schedule_run_id' in value ? value.schedule_run_id : undefined;
  const created_by_subject = 'created_by_subject' in value ? value.created_by_subject : undefined;
  if (typeof id !== 'string' || typeof kind !== 'string' || typeof title !== 'string' ||
      typeof body !== 'string' || typeof created_at !== 'string' || typeof updated_at !== 'string') {
    throw new Error('Invalid notification fields');
  }
  if (read_at !== null && typeof read_at !== 'string') {
    throw new Error('Invalid notification read_at');
  }
  let createdBySubject: WireNotification['created_by_subject'] = undefined;
  if (created_by_subject !== undefined && created_by_subject !== null) {
    if (typeof created_by_subject !== 'object') {
      throw new Error('Invalid notification created_by_subject');
    }
    const sid = 'subject_id' in created_by_subject ? created_by_subject.subject_id : undefined;
    const stype = 'subject_type' in created_by_subject ? created_by_subject.subject_type : undefined;
    const sname = 'subject_display_name' in created_by_subject ? created_by_subject.subject_display_name : undefined;
    if (typeof sid !== 'string' || typeof stype !== 'string' || typeof sname !== 'string') {
      throw new Error('Invalid notification created_by_subject fields');
    }
    createdBySubject = { subject_id: sid, subject_type: stype, subject_display_name: sname };
  }
  return {
    id,
    kind,
    title,
    body,
    schedule_id: typeof schedule_id === 'string' ? schedule_id : null,
    schedule_run_id: typeof schedule_run_id === 'string' ? schedule_run_id : null,
    read_at,
    created_at,
    updated_at,
    created_by_subject: createdBySubject,
  };
}

export function createNotificationsServer(
  options: CreateTrueForgeClientOptions,
): NotificationsServer {
  const baseUrl = resolveTrueForgeBaseUrl(options.baseUrl ?? '/').replace(/\/$/, '');
  const fetchFn = options.fetch ?? fetch;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token !== undefined && options.token !== '') {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetchFn(`${baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      throw new Error(`Notifications request failed: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  }

  return {
    async listNotifications(req?: ListNotificationsParams): Promise<ListResult<Notification>> {
      const limit = Math.min(Math.max(req?.limit ?? NOTIFICATIONS_PAGE_LIMIT, 1), NOTIFICATIONS_PAGE_LIMIT);
      const params = new URLSearchParams({ limit: String(limit) });
      if (req?.pageToken !== undefined && req.pageToken !== '') {
        params.set('page_token', req.pageToken);
      }
      const page = await request(`/api/v1/notifications?${params.toString()}`);
      if (typeof page !== 'object' || page === null || !('data' in page) || !Array.isArray(page.data)) {
        throw new Error('Invalid notifications list response');
      }
      const data = page.data.map((item: unknown) => toUiNotification(parseWireNotification(item)));
      const pagination = 'pagination' in page && typeof page.pagination === 'object' && page.pagination !== null
        ? page.pagination
        : {};
      const cursor = 'next_page_token' in pagination && typeof pagination.next_page_token === 'string'
        ? pagination.next_page_token
        : undefined;
      return {
        data,
        ...(cursor === undefined ? {} : { nextPageToken: cursor }),
      };
    },

    async markNotificationRead({ id }: { id: string }): Promise<Notification> {
      const response = await request(
        `/api/v1/notifications/${encodeURIComponent(id)}/read`,
        { method: 'PUT' },
      );
      if (typeof response !== 'object' || response === null || !('data' in response)) {
        throw new Error('Invalid mark-read response');
      }
      return toUiNotification(parseWireNotification(response.data));
    },

    async deleteNotification({ id }: { id: string }): Promise<void> {
      await request(`/api/v1/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  };
}
