/**
 * The two connector connection checks the Harness adds on top of the runtime's connector port,
 * and the wire contract of the memory one.
 *
 * The server owns the wire shape (`MemoryProviderCheckResultSchema` in the Harness's
 * `schemas/memoryProvider.ts`); this module is its single owner on the client, so the adapter
 * that calls the route and the settings container that renders the answer both derive from one
 * definition instead of restating it. It collapses into the generated SDK once that carries
 * `POST /mcp-servers/{name}/memory-check`.
 */
import { z } from 'zod';

/**
 * `code` is an open string rather than a restatement of the server's enum: a classification this
 * build has not seen must still reach the user through `reason` instead of failing validation.
 */
const MemoryProviderCheckResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({
    status: z.literal('failed'),
    code: z.string(),
    reason: z.string(),
    http_status: z.number().optional(),
    detail: z.string().optional(),
  }),
]);

const MemoryProviderCheckResponseSchema = z.object({ data: MemoryProviderCheckResultSchema });

/**
 * Outcome of the memory-provider connection check: one live recall against the Hindsight REST API
 * the host actually uses for memory, which is a different surface from the MCP endpoint a
 * connector's auth status reflects.
 */
export type MemoryProviderCheck = { ok: true } | { ok: false; code: string; reason: string };

/**
 * Why a connection test failed. `auth_required` and `unreachable` stay apart because the fix
 * differs: one is the credential, the other is the endpoint. `error` is anything the tools route
 * did not classify, reported as it arrived rather than guessed at.
 */
export type ConnectorConnectionFailureKind = 'auth_required' | 'unreachable' | 'error';

/**
 * Outcome of a connector connection test: one live MCP `tools/list` over the same url and headers
 * a turn resolves, so a connector that answers here is one a turn can use.
 */
export type ConnectorConnectionTest =
  { ok: true; toolNames: string[] } | { ok: false; kind: ConnectorConnectionFailureKind; message: string };

/** Both checks, as the Harness connector catalog exposes them. */
export interface ConnectorChecks {
  /** Re-runs the memory-provider connection check against a saved connector, changing nothing. */
  checkMemoryProvider(req: { id: string }): Promise<MemoryProviderCheck>;
  /** Dials a saved connector's MCP endpoint once and reports what it answered, changing nothing. */
  testConnector(req: { id: string }): Promise<ConnectorConnectionTest>;
}

/**
 * Whether a catalog implements the memory check. The runtime's connector port declares neither
 * check and another host's catalog may carry neither, so a settings surface reads for one and
 * hides the control that needs it when it is absent, rather than claiming the port is wider than
 * its type says.
 */
export function hasMemoryProviderCheck(catalog: object): catalog is Pick<ConnectorChecks, 'checkMemoryProvider'> {
  return typeof Reflect.get(catalog, 'checkMemoryProvider') === 'function';
}

/** Whether a catalog implements the connection test. See {@link hasMemoryProviderCheck}. */
export function hasConnectorConnectionTest(catalog: object): catalog is Pick<ConnectorChecks, 'testConnector'> {
  return typeof Reflect.get(catalog, 'testConnector') === 'function';
}

/**
 * Validates one memory-check response at the boundary and projects it onto the shape the UI reads.
 * @throws {Error} when the body does not match the contract
 */
export function parseMemoryProviderCheck(body: unknown): MemoryProviderCheck {
  const parsed = MemoryProviderCheckResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Memory check returned an unreadable response');
  }
  const result = parsed.data.data;
  return result.status === 'ok' ? { ok: true } : { ok: false, code: result.code, reason: result.reason };
}
