import fs from "node:fs";
import { buildAccountGmail } from "./account-gmail.js";
import { getAccountCredentialsPath, listAccounts, loadManifest, saveManifest } from "./accounts.js";
import { loadCredentials, type StoredCredentials } from "./credentials.js";

export type AccountAuthStatusCode =
  | "ok"
  | "needs_reauth"
  | "missing_credentials"
  | "invalid_credentials"
  | "unverified_limited_scope"
  | "unknown";

export interface AccountAuthStatus {
  id: string;
  status: AccountAuthStatusCode;
  message: string;
  checkedAt: string;
  credentialsPath: string;
  emailAddress: string | null;
  scopes: string[] | null;
}

interface StoredCredentialsShape {
  tokens?: Record<string, unknown>;
  scopes?: string[];
}

export interface AccountLiveVerifierInput {
  id: string;
  env: NodeJS.ProcessEnv;
  credentials: StoredCredentials;
  credentialsPath: string;
}

export interface AccountLiveVerification {
  emailAddress?: string | null;
}

export type AccountLiveVerifier = (
  input: AccountLiveVerifierInput,
) => Promise<AccountLiveVerification>;

export interface LiveAccountAuthStatusOptions {
  env?: NodeJS.ProcessEnv;
  verifier?: AccountLiveVerifier;
}

function parseCredentials(raw: string): StoredCredentialsShape {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  if (obj.tokens && typeof obj.tokens === "object") {
    return {
      tokens: obj.tokens as Record<string, unknown>,
      scopes: Array.isArray(obj.scopes) ? (obj.scopes as string[]) : undefined,
    };
  }
  return { tokens: obj };
}

export function checkAccountAuthStatus(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): AccountAuthStatus {
  const manifest = loadManifest({ env });
  const entry = manifest?.accounts[id];
  const credentialsPath = getAccountCredentialsPath(id, env);
  const checkedAt = new Date().toISOString();
  const base = {
    id,
    checkedAt,
    credentialsPath,
    emailAddress: entry?.emailAddress ?? null,
    scopes: entry?.scopes ?? null,
  };

  if (!fs.existsSync(credentialsPath)) {
    return {
      ...base,
      status: "missing_credentials",
      message: `Credentials file not found at ${credentialsPath}.`,
    };
  }

  let parsed: StoredCredentialsShape;
  try {
    parsed = parseCredentials(fs.readFileSync(credentialsPath, "utf8"));
  } catch (err) {
    return {
      ...base,
      status: "invalid_credentials",
      message: `Credentials JSON could not be parsed: ${(err as Error).message}`,
    };
  }

  const tokens = parsed.tokens ?? {};
  const scopes = parsed.scopes ?? entry?.scopes ?? null;
  const hasAccessToken = typeof tokens.access_token === "string" && tokens.access_token.length > 0;
  const hasRefreshToken =
    typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0;
  const expiryDate = typeof tokens.expiry_date === "number" ? tokens.expiry_date : null;

  if (!hasAccessToken && !hasRefreshToken) {
    return {
      ...base,
      scopes,
      status: "invalid_credentials",
      message: "Credentials file does not contain an access_token or refresh_token.",
    };
  }

  if (!hasRefreshToken && expiryDate !== null && expiryDate <= Date.now()) {
    return {
      ...base,
      scopes,
      status: "needs_reauth",
      message: "Access token is expired and no refresh_token is available.",
    };
  }

  return {
    ...base,
    scopes,
    status: "ok",
    message: "Credentials file is present and contains usable OAuth token material.",
  };
}

export function checkAndCacheAccountAuthStatus(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): AccountAuthStatus {
  const status = checkAccountAuthStatus(id, env);
  cacheAccountStatus(status, env);
  return status;
}

function cacheAccountStatus(status: AccountAuthStatus, env: NodeJS.ProcessEnv): void {
  const manifest = loadManifest({ env });
  if (manifest?.accounts[status.id]) {
    manifest.accounts[status.id] = {
      ...manifest.accounts[status.id],
      emailAddress: status.emailAddress ?? manifest.accounts[status.id].emailAddress,
      scopes: status.scopes ?? manifest.accounts[status.id].scopes,
      authStatus: status.status,
      authError: status.status === "ok" ? undefined : status.message,
      lastCheckedAt: status.checkedAt,
      updatedAt: status.checkedAt,
    };
    saveManifest(manifest, env);
  }
}

export function checkAllAccountAuthStatuses(
  env: NodeJS.ProcessEnv = process.env,
): AccountAuthStatus[] {
  return listAccounts(env).map((item) => checkAndCacheAccountAuthStatus(item.id, env));
}

export async function checkAndCacheAccountAuthStatusLive(
  id: string,
  opts: LiveAccountAuthStatusOptions = {},
): Promise<AccountAuthStatus> {
  const env = opts.env ?? process.env;
  const localStatus = checkAccountAuthStatus(id, env);
  if (localStatus.status !== "ok") {
    cacheAccountStatus(localStatus, env);
    return localStatus;
  }

  let loaded;
  try {
    loaded = await loadCredentials({ env, accountId: id });
  } catch (err) {
    const status: AccountAuthStatus = {
      ...localStatus,
      status: "invalid_credentials",
      message: `Could not reload credentials for live check: ${(err as Error).message}`,
    };
    cacheAccountStatus(status, env);
    return status;
  }

  try {
    const verifier = opts.verifier ?? defaultLiveVerifier;
    const verified = await verifier({
      id,
      env,
      credentials: loaded.credentials,
      credentialsPath: localStatus.credentialsPath,
    });
    const status: AccountAuthStatus = {
      ...localStatus,
      status: "ok",
      message: "OAuth credentials verified with the Gmail API.",
      emailAddress: verified.emailAddress ?? localStatus.emailAddress,
      scopes: loaded.credentials.scopes ?? localStatus.scopes,
    };
    cacheAccountStatus(status, env);
    return status;
  } catch (err) {
    const status = statusFromLiveVerifierError(localStatus, err);
    cacheAccountStatus(status, env);
    return status;
  }
}

export async function checkAllAccountAuthStatusesLive(
  opts: LiveAccountAuthStatusOptions = {},
): Promise<AccountAuthStatus[]> {
  const env = opts.env ?? process.env;
  const statuses: AccountAuthStatus[] = [];
  for (const item of listAccounts(env)) {
    statuses.push(
      await checkAndCacheAccountAuthStatusLive(item.id, {
        env,
        verifier: opts.verifier,
      }),
    );
  }
  return statuses;
}

async function defaultLiveVerifier({
  id,
  env,
  credentials,
}: AccountLiveVerifierInput): Promise<AccountLiveVerification> {
  // Reuse the shared handle factory with the already-loaded credentials — it
  // loads the OAuth keys, builds the client, and skips token persistence (this
  // is a throwaway probe). No session mutation.
  const { gmail } = await buildAccountGmail(id, { env, credentials });
  const profile = await gmail.users.getProfile({ userId: "me" });
  return { emailAddress: profile.data.emailAddress ?? null };
}

function statusFromLiveVerifierError(
  localStatus: AccountAuthStatus,
  err: unknown,
): AccountAuthStatus {
  const message = errorMessage(err);
  const statusCode = errorStatusCode(err);
  if (/invalid_grant|invalid grant|unauthorized|401/i.test(message) || statusCode === 401) {
    return {
      ...localStatus,
      status: "needs_reauth",
      message: `Live Gmail verification failed; re-authenticate this account: ${message}`,
    };
  }
  if (
    /insufficient.*scope|insufficient.*permission|forbidden|403/i.test(message) ||
    statusCode === 403
  ) {
    return {
      ...localStatus,
      status: "unverified_limited_scope",
      message: `Credentials are present, but Gmail profile verification is blocked by the granted scopes: ${message}`,
    };
  }
  return {
    ...localStatus,
    status: "unknown",
    message: `Could not verify credentials with Gmail API: ${message}`,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const extras = errorDetailStrings(err);
    return [err.message, ...extras].filter(Boolean).join(" ");
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function errorStatusCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const obj = err as Record<string, unknown>;
  if (typeof obj.code === "number") return obj.code;
  if (typeof obj.status === "number") return obj.status;
  const response = obj.response;
  if (response && typeof response === "object") {
    const responseObj = response as Record<string, unknown>;
    if (typeof responseObj.status === "number") return responseObj.status;
  }
  return null;
}

function errorDetailStrings(err: Error): string[] {
  const obj = err as unknown as Record<string, unknown>;
  const details: string[] = [];
  const response = obj.response;
  if (response && typeof response === "object") {
    const data = (response as Record<string, unknown>).data;
    if (data && typeof data === "object") {
      const dataObj = data as Record<string, unknown>;
      for (const key of ["error", "error_description", "message"]) {
        const value = dataObj[key];
        if (typeof value === "string") details.push(value);
      }
    }
  }
  return details;
}
