import { z } from '@hono/zod-openapi';

/**
 * One memory fact in a vault namespace. `id` is stable (`md:{namespace}:{file}#{index}`;
 * URL-encode it when used as a path param). `text` is the replacement text after a vault
 * edit, else the original retained text. `timestamp` is the edit time after a vault edit,
 * else the original retain time. `persona` names the owning persona for `persona:<name>`
 * vaults and is null otherwise.
 */
export const MemoryVaultEntrySchema = z
  .object({
    id: z.string(),
    text: z.string(),
    timestamp: z.string(),
    persona: z.string().nullable(),
  })
  .openapi('MemoryVaultEntry');

export type MemoryVaultEntry = z.infer<typeof MemoryVaultEntrySchema>;

/** Response item wrapper for a single vault entry. */
export const GetMemoryVaultEntryResponseSchema = z
  .object({
    data: MemoryVaultEntrySchema,
  })
  .openapi('GetMemoryVaultEntryResponse');

/** Vault entry listing response. */
export const ListMemoryVaultEntriesResponseSchema = z
  .object({
    data: z.array(MemoryVaultEntrySchema),
  })
  .openapi('ListMemoryVaultEntriesResponse');

/** New text for a vault entry. The old entry is kept and marked superseded. */
export const UpdateMemoryVaultEntryRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(32768),
  })
  .openapi('UpdateMemoryVaultEntryRequest');

/** Delete is idempotent and returns an empty object. */
export const DeleteMemoryVaultEntryResponseSchema = z.object({}).openapi('DeleteMemoryVaultEntryResponse');

/** A vault export: the namespace, when it was taken, and every effective entry. */
export const MemoryVaultExportSchema = z
  .object({
    namespace: z.string(),
    exported_at: z.string(),
    entries: z.array(MemoryVaultEntrySchema),
  })
  .openapi('MemoryVaultExport');

export const ExportMemoryVaultResponseSchema = z
  .object({
    data: MemoryVaultExportSchema,
  })
  .openapi('ExportMemoryVaultResponse');

/** One entry in an import payload. `timestamp` defaults to the import time. */
export const MemoryVaultImportEntrySchema = z
  .object({
    text: z.string().trim().min(1).max(32768),
    timestamp: z.string().optional(),
  })
  .openapi('MemoryVaultImportEntry');

export const ImportMemoryVaultRequestSchema = z
  .object({
    namespace: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe('Target vault namespace; omit for the shared vault.'),
    entries: z.array(MemoryVaultImportEntrySchema).min(1).max(500),
  })
  .openapi('ImportMemoryVaultRequest');

/** Result of an import: where the entries landed and how many were kept. */
export const MemoryVaultImportResultSchema = z
  .object({
    namespace: z.string(),
    imported: z.number().int().min(0),
  })
  .openapi('MemoryVaultImportResult');

export const ImportMemoryVaultResponseSchema = z
  .object({
    data: MemoryVaultImportResultSchema,
  })
  .openapi('ImportMemoryVaultResponse');

/**
 * Per-persona sharing config: which vault namespaces each persona may read.
 * Keys are persona names; values are vault namespaces (`default` for the shared vault).
 */
export const MemoryVaultSharingSchema = z
  .object({
    shares: z.record(z.string(), z.array(z.string())),
  })
  .openapi('MemoryVaultSharing');

export type MemoryVaultSharing = z.infer<typeof MemoryVaultSharingSchema>;

export const GetMemoryVaultSharingResponseSchema = z
  .object({
    data: MemoryVaultSharingSchema,
  })
  .openapi('GetMemoryVaultSharingResponse');

/** Replaces the whole sharing config; an omitted persona loses its shares. */
export const UpdateMemoryVaultSharingRequestSchema = z
  .object({
    shares: z.record(z.string(), z.array(z.string())),
  })
  .openapi('UpdateMemoryVaultSharingRequest');

/** Whether one vault namespace is still owed a turn summary after a failed attempt. */
export const MemoryVaultSummaryStatusSchema = z
  .object({
    summary_pending: z
      .boolean()
      .describe('True when the newest turn summary for this vault failed and has not been made yet.'),
  })
  .openapi('MemoryVaultSummaryStatus');

export const GetMemoryVaultSummaryStatusResponseSchema = z
  .object({
    data: MemoryVaultSummaryStatusSchema,
  })
  .openapi('GetMemoryVaultSummaryStatusResponse');
