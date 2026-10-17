// Session state for the active Gmail MCP process.
//
// Holds the singletons that the dispatcher closure used to capture from
// `main()` scope. Centralising them here lets `src/index.ts` shrink to an
// orchestrator and makes the in-process callers (CLI, TUI, HTTP wrapper)
// consume the same state without each rebuilding it.
//
// Single-process / single-active-account by design (Phase M1/M2-light). The
// active account can be swapped at runtime via setSession() — the
// `switch_account` MCP tool does this. Phase M3 (simultaneous multi-account)
// would replace this with a per-account session map.

import { EventEmitter } from "node:events";
import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import { READONLY_FALLBACK_SCOPES } from "../scopes.js";

let _oauth2Client: OAuth2Client | null = null;
let _gmail: gmail_v1.Gmail | null = null;
// Least privilege until an explicit scope list is loaded: a missing list must
// never grant write access by default.
let _authorizedScopes: string[] = READONLY_FALLBACK_SCOPES;
let _scopeNotice: string | null = null;
let _currentAccountId: string | null = null;
let _sessionEventSuppressions = 0;

/**
 * Fire-and-forget session event bus. Emits when the active account changes
 * (post-`setSession` with a different `accountId`). The TUI's `useAccount`
 * hook subscribes to refresh its account list / sidebar / inbox cache. CLI
 * and MCP-server consumers ignore — these events are advisory, never
 * load-bearing for correctness.
 *
 * Events:
 *   `accountChanged`  →  payload: { previous, current, scopes }
 *
 * Handlers MUST NOT throw — any exception propagates to the synchronous
 * `emit()` call site (`setSession`). Use a try/catch in the listener if
 * the handler can fail.
 *
 * `setMaxListeners(0)` removes the default 10-listener cap. Peak listener
 * count is small (≤2 in normal use); the cap exists to surface leaks. We
 * disable it because per-test re-subscribes are common and the cap would
 * spam stderr with warnings.
 */
export const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(0);

export interface AccountChangedPayload {
  previous: string | null;
  current: string | null;
  scopes: string[];
}

// Counters surfaced via health_check.
let _toolCallCount = 0;
const _recentErrorTs: number[] = [];
const ERROR_WINDOW_MS = 5 * 60_000;

export function setSession(opts: {
  oauth2Client: OAuth2Client;
  gmail: gmail_v1.Gmail;
  authorizedScopes?: string[];
  /**
   * Account id for the bound session. Used as a log tag and surfaced by
   * `list_accounts` / `switch_account`. `null` for env-driven single-account
   * mode (GMAIL_CREDENTIALS_JSON without a manifest) where the concept of a
   * named account doesn't apply.
   */
  accountId?: string | null;
  /** Plain-words warning for a connection holding a send-capable scope; null clears it. */
  scopeNotice?: string | null;
}): void {
  const previousAccountId = _currentAccountId;
  _oauth2Client = opts.oauth2Client;
  _gmail = opts.gmail;
  if (opts.authorizedScopes) _authorizedScopes = opts.authorizedScopes;
  if (opts.accountId !== undefined) _currentAccountId = opts.accountId;
  if (opts.scopeNotice !== undefined) _scopeNotice = opts.scopeNotice;

  // Emit only when the account id ACTUALLY changed. Same-id calls (bootstrap
  // → bootstrap re-run, or `switch_account` to the active account) are silent
  // — subscribers shouldn't refresh on a no-op.
  if (
    opts.accountId !== undefined &&
    opts.accountId !== previousAccountId &&
    _sessionEventSuppressions === 0
  ) {
    const payload: AccountChangedPayload = {
      previous: previousAccountId,
      current: _currentAccountId,
      scopes: _authorizedScopes,
    };
    sessionEvents.emit("accountChanged", payload);
  }
}

export async function withoutSessionChangeEvents<T>(fn: () => Promise<T>): Promise<T> {
  _sessionEventSuppressions += 1;
  try {
    return await fn();
  } finally {
    _sessionEventSuppressions -= 1;
  }
}

export function getCurrentAccountId(): string | null {
  return _currentAccountId;
}

export function setAuthorizedScopes(scopes: string[]): void {
  _authorizedScopes = scopes;
}

export function getOAuth2Client(): OAuth2Client {
  if (!_oauth2Client) {
    throw new Error("Session not initialised — call setSession() first (main()/bootstrap).");
  }
  return _oauth2Client;
}

export function getGmail(): gmail_v1.Gmail {
  if (!_gmail) {
    throw new Error("Session not initialised — call setSession() first (main()/bootstrap).");
  }
  return _gmail;
}

export function getScopeNotice(): string | null {
  return _scopeNotice;
}

export function getAuthorizedScopes(): string[] {
  return _authorizedScopes;
}

export function isSessionReady(): boolean {
  return _oauth2Client !== null && _gmail !== null;
}

// --- Counters -----------------------------------------------------------

export function incrementToolCallCount(): void {
  _toolCallCount += 1;
}

export function getToolCallCount(): number {
  return _toolCallCount;
}

export function recordToolError(): void {
  _recentErrorTs.push(Date.now());
  pruneErrorTimestamps();
}

export function getRecentErrorCount(): number {
  pruneErrorTimestamps();
  return _recentErrorTs.length;
}

/** Drop error timestamps older than the rolling window. Runs on both record
 *  and read so the array can't grow unboundedly between health checks. */
function pruneErrorTimestamps(): void {
  const cutoff = Date.now() - ERROR_WINDOW_MS;
  while (_recentErrorTs.length > 0 && (_recentErrorTs[0] ?? 0) < cutoff) {
    _recentErrorTs.shift();
  }
}

/**
 * Reset all session state. Test-only — not exported from the barrel.
 * Lets per-test cleanup avoid bleed between cases.
 */
export function _resetForTests(): void {
  _oauth2Client = null;
  _gmail = null;
  _authorizedScopes = READONLY_FALLBACK_SCOPES;
  _scopeNotice = null;
  _currentAccountId = null;
  _toolCallCount = 0;
  _recentErrorTs.length = 0;
  sessionEvents.removeAllListeners();
}
