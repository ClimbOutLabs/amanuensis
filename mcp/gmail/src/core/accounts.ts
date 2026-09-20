// Multi-account manifest for Gmail-MCP-Server.
//
// The manifest lives at <configDir>/accounts.json and tracks which named
// accounts exist + which one is the default. Per-account secrets (tokens,
// optional OAuth key override) live under <configDir>/accounts/<id>/.
//
// Resolution chain for the "active" account (first hit wins):
//   1. --account <id> CLI flag
//   2. GMAIL_ACCOUNT env var
//   3. defaultAccount field in the manifest
//   4. If manifest has exactly one account, use it
//   5. If no manifest but legacy <configDir>/credentials.json exists, treat
//      it as the implicit "default" account (back-compat for users who
//      haven't migrated yet)
//   6. No account configured.
//
// Single-account users who never invoke `gmail account` see no behaviour
// change — branches 5 and 6 keep the pre-M1 surface working.

import fs from "node:fs";
import path from "node:path";
import { getConfigDir, getCredentialsPath } from "./config-paths.js";

export interface AccountEntry {
  /** Email address (Gmail address) — populated lazily, may be empty until first tools/list. */
  emailAddress?: string;
  /** ISO timestamp of when the account was first added. */
  createdAt: string;
  /** Mirror of the scopes the credentials were minted with. Source of truth is credentials.json. */
  scopes?: string[];
  /** Last cached local auth-health status. Secrets never live in the manifest. */
  authStatus?:
    | "ok"
    | "needs_reauth"
    | "missing_credentials"
    | "invalid_credentials"
    | "unverified_limited_scope"
    | "unknown";
  /** Last non-secret auth-health error, if any. */
  authError?: string;
  /** ISO timestamp of the last account-health check. */
  lastCheckedAt?: string;
  /** ISO timestamp of the last metadata update. */
  updatedAt?: string;
}

export interface AccountManifest {
  /** ID of the account used when no --account / GMAIL_ACCOUNT is supplied. */
  defaultAccount: string;
  /** Account map keyed by id. */
  accounts: Record<string, AccountEntry>;
}

export type ActiveAccountResolutionSource =
  | "flag"
  | "env"
  | "manifest-default"
  | "manifest-sole"
  | "legacy-implicit"
  | "none";

export interface ActiveAccount {
  /** Resolved account id, or null when none can be inferred. */
  id: string | null;
  source: ActiveAccountResolutionSource;
  /**
   * True when the resolved account predates a real manifest entry (we have
   * <configDir>/credentials.json but no accounts.json yet). Loaders use this
   * to trigger the migration shim that promotes the legacy file into the new
   * per-account directory on first read.
   */
  isLegacyImplicit: boolean;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  /** Value of --account from the CLI, if any. */
  flagAccount?: string | null;
  /** Injectable test seam. */
  fileExists?: (p: string) => boolean;
  /** Injectable test seam. */
  readFile?: (p: string, enc: BufferEncoding) => string;
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const RESERVED_IDS = new Set<string>([]);

export class InvalidAccountIdError extends Error {
  constructor(
    public id: string,
    message: string,
  ) {
    super(message);
    this.name = "InvalidAccountIdError";
  }
}

export class AccountNotFoundError extends Error {
  constructor(public id: string) {
    super(`Account "${id}" not found in manifest.`);
    this.name = "AccountNotFoundError";
  }
}

/**
 * Validate an account id. Accepts [A-Za-z0-9][A-Za-z0-9_.-]{0,63}; rejects
 * empty strings, leading punctuation, and reserved names. Throws on failure.
 */
export function validateAccountId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new InvalidAccountIdError(id, "Account id must be a non-empty string.");
  }
  if (!ACCOUNT_ID_RE.test(id)) {
    throw new InvalidAccountIdError(
      id,
      `Account id "${id}" is invalid. Use 1-64 chars, starting with [A-Za-z0-9], remainder [A-Za-z0-9_.-].`,
    );
  }
  if (RESERVED_IDS.has(id)) {
    throw new InvalidAccountIdError(id, `Account id "${id}" is reserved.`);
  }
}

export function getAccountsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDir(env), "accounts");
}

export function getAccountDir(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  validateAccountId(accountId);
  return path.join(getAccountsDir(env), accountId);
}

export function getManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDir(env), "accounts.json");
}

export function loadManifest(
  opts: {
    env?: NodeJS.ProcessEnv;
    readFile?: (p: string, e: BufferEncoding) => string;
    fileExists?: (p: string) => boolean;
  } = {},
): AccountManifest | null {
  const env = opts.env ?? process.env;
  const fileExists = opts.fileExists ?? ((p) => fs.existsSync(p));
  const readFile = opts.readFile ?? ((p, e) => fs.readFileSync(p, e));
  const manifestPath = getManifestPath(env);
  if (!fileExists(manifestPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse ${manifestPath}: ${(err as Error).message}`, { cause: err });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${manifestPath} must contain a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  const defaultAccount = typeof obj.defaultAccount === "string" ? obj.defaultAccount : "";
  const rawAccounts =
    obj.accounts && typeof obj.accounts === "object"
      ? (obj.accounts as Record<string, unknown>)
      : {};
  const accounts: Record<string, AccountEntry> = {};
  for (const [id, raw] of Object.entries(rawAccounts)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    accounts[id] = {
      emailAddress: typeof entry.emailAddress === "string" ? entry.emailAddress : undefined,
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date(0).toISOString(),
      scopes: Array.isArray(entry.scopes) ? (entry.scopes as string[]) : undefined,
      authStatus:
        typeof entry.authStatus === "string"
          ? (entry.authStatus as AccountEntry["authStatus"])
          : undefined,
      authError: typeof entry.authError === "string" ? entry.authError : undefined,
      lastCheckedAt: typeof entry.lastCheckedAt === "string" ? entry.lastCheckedAt : undefined,
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
    };
  }
  return { defaultAccount, accounts };
}

/** Atomic JSON write — tmp file + rename. */
export function saveManifest(
  manifest: AccountManifest,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const configDir = getConfigDir(env);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  const target = getManifestPath(env);
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function addAccount(
  id: string,
  entry: Partial<AccountEntry> = {},
  env: NodeJS.ProcessEnv = process.env,
): AccountManifest {
  validateAccountId(id);
  const manifest = loadManifest({ env }) ?? { defaultAccount: id, accounts: {} };
  const existed = !!manifest.accounts[id];
  manifest.accounts[id] = {
    createdAt: manifest.accounts[id]?.createdAt ?? entry.createdAt ?? new Date().toISOString(),
    emailAddress: entry.emailAddress ?? manifest.accounts[id]?.emailAddress,
    scopes: entry.scopes ?? manifest.accounts[id]?.scopes,
    authStatus: entry.authStatus ?? manifest.accounts[id]?.authStatus,
    authError: entry.authError ?? manifest.accounts[id]?.authError,
    lastCheckedAt: entry.lastCheckedAt ?? manifest.accounts[id]?.lastCheckedAt,
    updatedAt: entry.updatedAt ?? manifest.accounts[id]?.updatedAt,
  };
  // First account auto-becomes default.
  if (!manifest.defaultAccount || (!existed && Object.keys(manifest.accounts).length === 1)) {
    manifest.defaultAccount = id;
  }
  saveManifest(manifest, env);
  return manifest;
}

export function removeAccount(id: string, env: NodeJS.ProcessEnv = process.env): AccountManifest {
  const manifest = loadManifest({ env });
  if (!manifest || !manifest.accounts[id]) {
    throw new AccountNotFoundError(id);
  }
  delete manifest.accounts[id];
  const remainingIds = Object.keys(manifest.accounts);
  if (manifest.defaultAccount === id) {
    manifest.defaultAccount = remainingIds[0] ?? "";
  }
  saveManifest(manifest, env);
  return manifest;
}

export function setDefaultAccount(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): AccountManifest {
  validateAccountId(id);
  const manifest = loadManifest({ env });
  if (!manifest || !manifest.accounts[id]) {
    throw new AccountNotFoundError(id);
  }
  manifest.defaultAccount = id;
  saveManifest(manifest, env);
  return manifest;
}

export interface AccountListItem {
  id: string;
  entry: AccountEntry;
  isDefault: boolean;
}

export function listAccounts(env: NodeJS.ProcessEnv = process.env): AccountListItem[] {
  const manifest = loadManifest({ env });
  if (!manifest) return [];
  return Object.entries(manifest.accounts)
    .map(([id, entry]) => ({ id, entry, isDefault: id === manifest.defaultAccount }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Resolve the active account using the precedence chain documented at the
 * top of this file. Pure: no side-effects, no migrations. Step 2 wires the
 * migration shim into the credential loader instead.
 */
export function resolveActiveAccount(opts: ResolveOptions = {}): ActiveAccount {
  const env = opts.env ?? process.env;
  const fileExists = opts.fileExists ?? ((p) => fs.existsSync(p));
  const flag =
    opts.flagAccount && opts.flagAccount.trim().length > 0 ? opts.flagAccount.trim() : null;
  if (flag) {
    validateAccountId(flag);
    return { id: flag, source: "flag", isLegacyImplicit: false };
  }
  const envAccount = env.GMAIL_ACCOUNT;
  if (envAccount && envAccount.trim().length > 0) {
    const id = envAccount.trim();
    validateAccountId(id);
    return { id, source: "env", isLegacyImplicit: false };
  }
  const manifest = loadManifest({ env, readFile: opts.readFile, fileExists });
  if (manifest) {
    const ids = Object.keys(manifest.accounts);
    if (manifest.defaultAccount && manifest.accounts[manifest.defaultAccount]) {
      return { id: manifest.defaultAccount, source: "manifest-default", isLegacyImplicit: false };
    }
    if (ids.length === 1) {
      return { id: ids[0], source: "manifest-sole", isLegacyImplicit: false };
    }
    // Manifest exists but has no default and either zero or multiple accounts —
    // fall through and let the loader emit a useful error.
    return { id: null, source: "none", isLegacyImplicit: false };
  }
  // No manifest. If legacy credentials.json exists, treat as implicit "default".
  // We intentionally do NOT check env-driven credential paths here — env-based
  // single-account deployments (GMAIL_CREDENTIALS_JSON / GMAIL_CREDENTIALS_OP)
  // don't have a config dir to migrate, so they keep working without a manifest.
  const legacyCredentials = getCredentialsPath(env);
  if (
    !env.GMAIL_CREDENTIALS_JSON &&
    !env.GMAIL_CREDENTIALS_OP &&
    !env.GMAIL_CREDENTIALS_PATH &&
    fileExists(legacyCredentials)
  ) {
    return { id: "default", source: "legacy-implicit", isLegacyImplicit: true };
  }
  return { id: null, source: "none", isLegacyImplicit: false };
}

/** Per-account credentials.json path (regardless of the legacy file's existence). */
export function getAccountCredentialsPath(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getAccountDir(accountId, env), "credentials.json");
}

/** Per-account gcp-oauth.keys.json path (override; shared file at configDir is the fallback). */
export function getAccountOAuthPath(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getAccountDir(accountId, env), "gcp-oauth.keys.json");
}
