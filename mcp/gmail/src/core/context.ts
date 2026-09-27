// Operation context — the dependency bundle handed to every registry op.
//
// Replaces the closure capture pattern in the old monolithic dispatcher
// (gmail / oauth2Client / signal / authorizedScopes were all reached via
// `main()`'s lexical scope). With ops as standalone functions, every dep
// becomes an explicit field on this object.

import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import { getAuthorizedScopes, getCurrentAccountId, getGmail, getOAuth2Client } from "./session.js";

export interface OperationContext {
  gmail: gmail_v1.Gmail;
  oauth2Client: OAuth2Client;
  authorizedScopes: string[];
  signal?: AbortSignal;
  /** Tool name; mainly for log correlation inside the handler. */
  toolName: string;
  /**
   * Account id pinned at request start. The session is a process-global
   * singleton: `switch_account` (or a concurrent request) can swap the
   * active account mid-request. Handlers must scope per-request state
   * (notably idempotency records) to THIS id — the account the request's
   * gmail client was bound to — not to whatever `getCurrentAccountId()`
   * returns at use time. `null` in env-driven single-account mode.
   */
  accountId: string | null;
}

/**
 * Build an OperationContext from the current session + a per-request signal.
 * Throws if the session hasn't been initialised (call setSession first).
 */
export function createContext(opts: { toolName: string; signal?: AbortSignal }): OperationContext {
  return {
    gmail: getGmail(),
    oauth2Client: getOAuth2Client(),
    authorizedScopes: getAuthorizedScopes(),
    signal: opts.signal,
    toolName: opts.toolName,
    // Pin the account alongside the gmail client: both are snapshotted here
    // so a mid-request account switch cannot descope this request's work.
    accountId: getCurrentAccountId(),
  };
}
