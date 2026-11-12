import { z } from 'zod';

import { getErrorMessage } from '../../../utils/getErrorMessage.js';
import type { CreateTrueForgeClientOptions } from '../client.js';
import { createMemoryRequester } from './memoryRequest.js';

/** One memory fact as the vault presents it. */
const MemoryVaultEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  timestamp: z.string(),
  persona: z.string().nullable(),
});

/** Per-persona sharing config: which vault namespaces each persona may read. */
const MemoryVaultSharingSchema = z.object({
  shares: z.record(z.string(), z.array(z.string())),
});

export type MemoryVaultEntry = z.infer<typeof MemoryVaultEntrySchema>;
export type MemoryVaultSharing = z.infer<typeof MemoryVaultSharingSchema>;

/** One older note the person may mark as their own words. */
export type MemoryVaultReviewNote = {
  entryId: string;
  day: string;
  text: string;
  chatTitle: string | null;
};

/** The older notes found by one request, and where the next request starts (null when none are left to look at). */
export type MemoryVaultReviewList = {
  notes: MemoryVaultReviewNote[];
  nextCursor: string | null;
};

/** What marking older notes did: the ids marked, and each note that was left as it is with the reason in plain words. */
export type MemoryVaultReviewResult = {
  markedIds: string[];
  refused: { entryId: string; reason: string }[];
};

/** Whether a vault is still owed a turn summary after a failed attempt. */
export type MemoryVaultSummaryStatus = {
  summaryPending: boolean;
};

/** Wire namespace of a persona's own vault. */
export function personaVaultNamespace(displayName: string): string {
  return `persona:${displayName}`;
}

export interface MemoryVaultCatalog {
  listEntries(namespace?: string): Promise<MemoryVaultEntry[]>;
  getSummaryStatus(namespace?: string): Promise<MemoryVaultSummaryStatus>;
  updateEntry(options: { entryId: string; text: string }): Promise<MemoryVaultEntry>;
  deleteEntry(entryId: string): Promise<void>;
  exportEntries(namespace?: string): Promise<{ namespace: string; exportedAt: string; entries: MemoryVaultEntry[] }>;
  importEntries(options: {
    namespace?: string;
    entries: Array<{ text: string; timestamp?: string }>;
  }): Promise<{ namespace: string; imported: number }>;
  getSharing(): Promise<MemoryVaultSharing>;
  updateSharing(sharing: MemoryVaultSharing): Promise<MemoryVaultSharing>;
  /** Older notes the person may mark as their own. A server without them leaves these out. */
  listReviewNotes?(options: { namespace?: string; cursor?: string }): Promise<MemoryVaultReviewList>;
  markReviewNotes?(options: { namespace?: string; entryIds: string[] }): Promise<MemoryVaultReviewResult>;
}

const ReviewListSchema = z.object({
  data: z.object({
    notes: z.array(
      z.object({ entry_id: z.string(), day: z.string(), text: z.string(), chat_title: z.string().nullable() }),
    ),
    next_cursor: z.string().nullable(),
  }),
});

const ReviewResultSchema = z.object({
  data: z.object({
    marked_ids: z.array(z.string()),
    refused: z.array(z.object({ entry_id: z.string(), reason: z.string() })),
  }),
});

function parseEntry(body: unknown): MemoryVaultEntry {
  const parsed = z.object({ data: MemoryVaultEntrySchema }).safeParse(body);
  if (!parsed.success) {
    throw new Error('The server returned an unexpected memory payload');
  }
  return parsed.data.data;
}

function parseEntries(body: unknown): MemoryVaultEntry[] {
  const parsed = z.object({ data: z.array(MemoryVaultEntrySchema) }).safeParse(body);
  if (!parsed.success) {
    throw new Error('The server returned an unexpected memory payload');
  }
  return parsed.data.data;
}

function parseSharing(body: unknown): MemoryVaultSharing {
  const parsed = z.object({ data: MemoryVaultSharingSchema }).safeParse(body);
  if (!parsed.success) {
    throw new Error('The server returned an unexpected memory payload');
  }
  return parsed.data.data;
}

/**
 * Calls the memory vault routes with the same base URL, token, and fetch the
 * SDK client was built from. Direct rather than through the client because the
 * generated SDK does not carry these routes yet; it moves onto the client at
 * the next regeneration. Cookie auth rides along: the default base URL is
 * same-origin, and a host pointing the UI at another origin supplies its own `fetch`.
 */
export function createMemoryVaultCatalog(options: CreateTrueForgeClientOptions = {}): MemoryVaultCatalog {
  const { request, namespaceQuery } = createMemoryRequester(options);

  return {
    listEntries: namespace =>
      request('GET', `/api/v1/memory/vault${namespaceQuery(namespace)}`, undefined, parseEntries),
    getSummaryStatus: async namespace => {
      const parsed = z
        .object({ data: z.object({ summary_pending: z.boolean() }) })
        .safeParse(
          await request(
            'GET',
            `/api/v1/memory/vault/summary-status${namespaceQuery(namespace)}`,
            undefined,
            value => value,
          ),
        );
      if (!parsed.success) {
        throw new Error('The server returned an unexpected memory payload');
      }
      return { summaryPending: parsed.data.data.summary_pending };
    },
    updateEntry: ({ entryId, text }) =>
      request('PUT', `/api/v1/memory/vault/${encodeURIComponent(entryId)}`, { text }, parseEntry),
    deleteEntry: entryId =>
      request('DELETE', `/api/v1/memory/vault/${encodeURIComponent(entryId)}`, undefined, () => undefined),
    exportEntries: async namespace => {
      const parsed = z
        .object({
          data: z.object({
            namespace: z.string(),
            exported_at: z.string(),
            entries: z.array(MemoryVaultEntrySchema),
          }),
        })
        .safeParse(
          await request('GET', `/api/v1/memory/vault/export${namespaceQuery(namespace)}`, undefined, value => value),
        );
      if (!parsed.success) {
        throw new Error('The server returned an unexpected memory payload');
      }
      return {
        namespace: parsed.data.data.namespace,
        exportedAt: parsed.data.data.exported_at,
        entries: parsed.data.data.entries,
      };
    },
    importEntries: async ({ namespace, entries }) => {
      const parsed = z
        .object({ data: z.object({ namespace: z.string(), imported: z.number() }) })
        .safeParse(
          await request(
            'POST',
            '/api/v1/memory/vault/import',
            { ...(namespace === undefined ? {} : { namespace }), entries },
            value => value,
          ),
        );
      if (!parsed.success) {
        throw new Error('The server returned an unexpected memory payload');
      }
      return parsed.data.data;
    },
    listReviewNotes: async ({ namespace, cursor }) => {
      const params = new URLSearchParams();
      if ((namespace ?? '').trim() !== '') params.set('namespace', (namespace ?? '').trim());
      if (cursor !== undefined) params.set('cursor', cursor);
      const query = params.size === 0 ? '' : `?${params.toString()}`;
      const parsed = ReviewListSchema.safeParse(
        await request('GET', `/api/v1/memory/vault/review${query}`, undefined, value => value),
      );
      if (!parsed.success) {
        throw new Error('The server returned an unexpected memory payload');
      }
      return {
        notes: parsed.data.data.notes.map(note => ({
          entryId: note.entry_id,
          day: note.day,
          text: note.text,
          chatTitle: note.chat_title,
        })),
        nextCursor: parsed.data.data.next_cursor,
      };
    },
    markReviewNotes: async ({ namespace, entryIds }) => {
      const parsed = ReviewResultSchema.safeParse(
        await request(
          'POST',
          '/api/v1/memory/vault/review',
          { ...(namespace === undefined || namespace === '' ? {} : { namespace }), entry_ids: entryIds },
          value => value,
        ),
      );
      if (!parsed.success) {
        throw new Error('The server returned an unexpected memory payload');
      }
      return {
        markedIds: parsed.data.data.marked_ids,
        refused: parsed.data.data.refused.map(item => ({ entryId: item.entry_id, reason: item.reason })),
      };
    },
    getSharing: () => request('GET', '/api/v1/memory/vault/sharing', undefined, parseSharing),
    updateSharing: sharing => request('PUT', '/api/v1/memory/vault/sharing', sharing, parseSharing),
  };
}

/** Human-readable error for vault actions; callers render it inline. */
export function memoryVaultErrorMessage(error: unknown): string {
  return getErrorMessage(error, 'The memory request failed');
}
