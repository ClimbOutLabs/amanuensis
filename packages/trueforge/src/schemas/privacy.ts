/**
 * Privacy product surface schemas (mounted at /api/v1/privacy).
 *
 * Wire fields stay snake_case per the OpenAPI naming convention
 * (`packages/trueforge/AGENTS.md`).
 */
import { z } from '@hono/zod-openapi';

/**
 * One external connection the system can make. This is the machine-readable
 * half of the data-flow documentation: the docs page (`docs/privacy-data-flow.mdx`)
 * and the Settings > Privacy data-flow viewer both render from this shape.
 */
export const DataFlowConnectionSchema = z
  .object({
    /** Stable id, e.g. `model-provider`. */
    id: z.string(),
    /** Short category label, e.g. `Model API`. */
    category: z.string(),
    /** Where the data goes: the configured URL or service. */
    destination: z.string(),
    /** What data leaves the box on this connection, in plain language. */
    data_sent: z.string(),
    /** Why the connection exists. */
    purpose: z.string(),
    /** How to stop this connection from happening. */
    how_to_disable: z.string(),
  })
  .openapi('DataFlowConnection');

export type DataFlowConnection = z.infer<typeof DataFlowConnectionSchema>;

export const DataFlowManifestSchema = z
  .object({
    /** Manifest version; bump when the connection list changes shape. */
    version: z.string(),
    connections: z.array(DataFlowConnectionSchema),
  })
  .openapi('DataFlowManifest');

export type DataFlowManifest = z.infer<typeof DataFlowManifestSchema>;

export const GetDataFlowManifestResponseSchema = z
  .object({ data: DataFlowManifestSchema })
  .openapi('GetDataFlowManifestResponse');

/** Offline-mode state: whether the server currently refuses non-local network calls. */
export const OfflineModeStateSchema = z
  .object({
    enabled: z.boolean(),
  })
  .openapi('OfflineModeState');

export type OfflineModeState = z.infer<typeof OfflineModeStateSchema>;

export const GetOfflineModeResponseSchema = z
  .object({ data: OfflineModeStateSchema })
  .openapi('GetOfflineModeResponse');

export const UpdateOfflineModeRequestSchema = z
  .object({
    enabled: z.boolean(),
  })
  .openapi('UpdateOfflineModeRequest');
