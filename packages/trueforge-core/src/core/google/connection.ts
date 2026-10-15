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

export const GOOGLE_CONNECTION_STATUSES = ['connected', 'needs_reconnect'] as const;
export type GoogleConnectionStatus = (typeof GOOGLE_CONNECTION_STATUSES)[number];

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

export interface GoogleConnectionStore {
  get(owner: GoogleOwner): Promise<GoogleConnectionRecord | null>;
  /** Inserts or replaces the user's login. */
  save(record: GoogleConnectionRecord): Promise<void>;
  /** Flags the login as no longer working; a missing login stays missing. */
  markNeedsReconnect(owner: GoogleOwner): Promise<void>;
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
  /** Returns and removes the user's consent in flight, so a state can be used once. */
  takePending(owner: GoogleOwner): Promise<PendingGoogleAuthorization | null>;
}
