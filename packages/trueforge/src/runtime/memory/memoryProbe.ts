/**
 * Live check of the surface host-enforced memory actually speaks.
 *
 * A connector's `auth_status` only reflects its MCP endpoint, while memory recalls and retains
 * over the Hindsight REST API. Hindsight can be deployed with those two surfaces validating
 * different credentials, so a connector can read as authenticated and still fail every recall
 * with HTTP 401. This runs one real, minimal recall through {@link HindsightClient} so the save
 * path exercises the same header resolution, timeout, and byte caps a turn does, and reports
 * what the provider actually said.
 *
 * Never throws: every failure comes back as a structured `ok:false` outcome.
 */
import type { RemoteMcpHeaders } from '@truefoundry/trueforge-core/core';
import { HindsightClient, type MemoryFailure } from './hindsightClient';
import { parseMemoryProviderUrl } from './memoryProvider';

/**
 * Query the check sends. Trivial on purpose: nothing is read out of the answer beyond the fact
 * that the provider authenticated the request and answered it.
 */
export const MEMORY_PROBE_QUERY = 'memory provider connection check';

/** Smallest budgets that still form a valid recall request; the results are discarded. */
const PROBE_MAX_TOKENS = 16;
const PROBE_ENTITY_TOKENS = 16;

export type MemoryProviderCheckOutcome = { ok: true } | MemoryFailure;

export async function probeMemoryProvider(input: {
  apiBase: string;
  bank: string;
  headers: RemoteMcpHeaders;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<MemoryProviderCheckOutcome> {
  const client = new HindsightClient({
    apiBase: input.apiBase,
    bank: input.bank,
    headers: input.headers,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  try {
    const outcome = await client.recall({
      query: MEMORY_PROBE_QUERY,
      maxTokens: PROBE_MAX_TOKENS,
      entityTokens: PROBE_ENTITY_TOKENS,
      queryTimestamp: new Date().toISOString(),
      timeoutMs: input.timeoutMs,
    });
    return outcome.ok ? { ok: true } : outcome;
  } catch (error) {
    // Defense in depth: HindsightClient.recall is documented never to throw, but a client bug
    // must not turn a connector save into a 500.
    return {
      ok: false,
      code: 'request_failed',
      reason: `memory provider check threw unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Same check, addressed by the connector's MCP URL: parses `{apiBase}/mcp/{bank}` (the only
 * shape memory can use) and probes the REST API behind it.
 */
export async function checkMemoryProviderUrl(input: {
  url: string;
  headers: RemoteMcpHeaders;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<MemoryProviderCheckOutcome> {
  const parsed = parseMemoryProviderUrl(input.url);
  if (parsed === undefined) {
    return {
      ok: false,
      code: 'invalid_url',
      reason: `memory provider URL must be a single-bank Hindsight MCP URL ({apiBase}/mcp/{bank}): ${input.url}`,
    };
  }
  return probeMemoryProvider({
    apiBase: parsed.apiBase,
    bank: parsed.bank,
    headers: input.headers,
    timeoutMs: input.timeoutMs,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
}
