import { z } from 'zod';

import { getErrorMessage } from '../../../utils/getErrorMessage.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

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

/** Wire namespace of a persona's own vault. */
export function personaVaultNamespace(displayName: string): string {
  return `persona:${displayName}`;
}

export interface MemoryVaultCatalog {
  listEntries(namespace?: string): Promise<MemoryVaultEntry[]>;
  updateEntry(options: { entryId: string; text: string }): Promise<MemoryVaultEntry>;
  deleteEntry(entryId: string): Promise<void>;
  exportEntries(namespace?: string): Promise<{ namespace: string; exportedAt: string; entries: MemoryVaultEntry[] }>;
  importEntries(options: {
    namespace?: string;
    entries: Array<{ text: string; timestamp?: string }>;
  }): Promise<{ namespace: string; imported: number }>;
  getSharing(): Promise<MemoryVaultSharing>;
  updateSharing(sharing: MemoryVaultSharing): Promise<MemoryVaultSharing>;
}

const ErrorSchema = z.object({ error: z.object({ message: z.string() }) });

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
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request<T>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    parse: (payload: unknown) => T,
  ): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseBody: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const failure = ErrorSchema.safeParse(responseBody);
      throw new Error(
        failure.success ? failure.data.error.message : `Memory request failed with HTTP ${String(response.status)}`,
      );
    }
    return parse(responseBody);
  }

  const namespaceQuery = (namespace: string | undefined): string => {
    const trimmed = (namespace ?? '').trim();
    return trimmed === '' ? '' : `?namespace=${encodeURIComponent(trimmed)}`;
  };

  return {
    listEntries: namespace =>
      request('GET', `/api/v1/memory/vault${namespaceQuery(namespace)}`, undefined, parseEntries),
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
    getSharing: () => request('GET', '/api/v1/memory/vault/sharing', undefined, parseSharing),
    updateSharing: sharing => request('PUT', '/api/v1/memory/vault/sharing', sharing, parseSharing),
  };
}

/** Human-readable error for vault actions; callers render it inline. */
export function memoryVaultErrorMessage(error: unknown): string {
  return getErrorMessage(error, 'The memory request failed');
}
