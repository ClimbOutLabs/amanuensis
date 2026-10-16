/**
 * The stored Google login for one user, and the narrow ports the connect flow and the tools use to read and
 * keep it. The server owns persistence (SQLite and Postgres); core only sees these contracts.
 */
import type { ClientType } from './clientJson';

/** Whose login this is. Both parts are server-derived, never from a request body or the model. */
export interface GoogleOwner {
  tenant_id: string;
  created_by: string;
}

export type GoogleConnectionStatus = 'connected' | 'needs_reconnect';

export interface GoogleConnectionRecord extends GoogleOwner {
  client_id: string;
  client_secret: string;
  client_type: ClientType;
  refresh_token: string;
  /** Scopes Google actually returned; tools are gated on these, not on what was asked for. */
  granted_scopes: string[];
  account_email: string | null;
  status: GoogleConnectionStatus;
  created_at: string;
  updated_at: string;
}

/** Identifies the exact login a caller read, so a later write can tell whether the row was replaced meanwhile. */
export type GoogleConnectionVersion = Pick<GoogleConnectionRecord, 'refresh_token' | 'updated_at'>;

export interface GoogleConnectionStore {
  get(owner: GoogleOwner): Promise<GoogleConnectionRecord | null>;
  /** Inserts or replaces the user's login. */
  save(record: GoogleConnectionRecord): Promise<void>;
  /**
   * Flags the login as no longer working, only if the row still is the one read; a login that was
   * replaced or removed in the meantime is left alone. Returns whether the row changed.
   */
  markNeedsReconnect(input: { owner: GoogleOwner; expected: GoogleConnectionVersion }): Promise<boolean>;
  /** Records the address Google names, under the same condition. Returns whether the row changed. */
  setAccountEmail(input: {
    owner: GoogleOwner;
    expected: GoogleConnectionVersion;
    account_email: string;
    updated_at: string;
  }): Promise<boolean>;
  delete(owner: GoogleOwner): Promise<void>;
}

/** One consent in flight. The verifier and the client secret stay on the server and never reach the browser. */
export interface PendingGoogleAuthorization extends GoogleOwner {
  state_hash: string;
  pkce_verifier: string;
  client_id: string;
  client_secret: string;
  client_type: ClientType;
  redirect_uri: string;
  scopes: string[];
  created_at: string;
}

export interface PendingGoogleAuthorizationStore {
  /** A user has at most one consent in flight; saving replaces it. */
  savePending(pending: PendingGoogleAuthorization): Promise<void>;
  /**
   * Returns and removes the user's consent in flight, but only when its state hash matches, so a state can be
   * used once and a wrong state never spends the real attempt.
   */
  takePending(input: GoogleOwner & { state_hash: string }): Promise<PendingGoogleAuthorization | null>;
  /** Whether the user has a consent in flight, to tell "none" from "not that one". */
  hasPending(owner: GoogleOwner): Promise<boolean>;
  /** Drops the user's consent in flight, whatever its state. */
  clearPending(owner: GoogleOwner): Promise<void>;
}
