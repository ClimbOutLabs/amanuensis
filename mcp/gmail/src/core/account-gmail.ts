// Session-free per-account Gmail handle factory.
//
// Builds an { oauth2Client, gmail, scopes } bundle for ONE named account
// WITHOUT touching the process session singletons. Folds together the
// OAuth-keys loader + credential loader + fixture-mode branches that were
// previously duplicated across three call sites:
//   - bootstrap            (src/index.ts)         — the active session
//   - switch_account       (core/ops/accounts.ts) — swaps the active session
//   - defaultLiveVerifier  (core/account-status.ts) — a throwaway probe
// and now the cross-account unread summary (unread_summary), which needs N
// independent handles — one per account — none of which is the "active" one.
//
// Like account-status.ts, this is a Gmail-coupled seam: it imports
// google-auth-library + googleapis on purpose. Keep the Gmail-agnostic core
// modules (credentials.ts, config-paths.ts, accounts.ts) free of those imports.

import { OAuth2Client } from "google-auth-library";
import { type gmail_v1, google } from "googleapis";
import { loadOAuthKeys } from "./auth-flow.js";
import { getConfigDir, getOAuthPath } from "./config-paths.js";
import {
  attachTokenPersistence,
  CredentialLoadError,
  type LoadedCredentials,
  loadCredentials,
  type StoredCredentials,
} from "./credentials.js";
import { READONLY_FALLBACK_SCOPES } from "../scopes.js";

const OAUTH_CALLBACK = "http://localhost:3000/oauth2callback";

/** Which loader stage failed. Callers map this onto their own error type. */
export type AccountGmailStage = "oauth-keys" | "credentials" | "fixture";

/**
 * Typed error carrying the loader stage that failed. bootstrap maps stage →
 * BootstrapError(stage); switch_account maps it to its "failed to load …"
 * messages. Centralising the stages here keeps the three callers' error
 * semantics identical without duplicating the load code.
 */
export class AccountGmailError extends Error {
  constructor(
    public stage: AccountGmailStage,
    message: string,
    public override cause?: unknown,
  ) {
    super(message);
    this.name = "AccountGmailError";
  }
}

export interface BuildAccountGmailOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Pre-loaded credentials. When supplied, the factory skips the credential
   * loader chain entirely and uses these tokens verbatim (the live-verifier
   * path, which already loaded them to distinguish load errors). Implies no
   * token persistence (the probe handle is discarded immediately).
   */
  credentials?: StoredCredentials;
  /**
   * Legacy single-account fallback file, passed through to loadCredentials.
   * Only consulted when accountId is unset (unmigrated single-account users).
   */
  fallbackPath?: string;
  /**
   * When false, a MISSING credentials file is tolerated: the returned handle
   * has no tokens set and scopes=[] (first-time `gmail account auth` bootstrap
   * needs an OAuth client before any credentials exist). Any other load error
   * (malformed JSON, env-json/1Password failures) still throws. Default true.
   */
  requireCredentials?: boolean;
  /**
   * Attach google-auth-library token-rotation persistence for file-backed
   * credentials. Default true when the factory loads the creds itself; always
   * off when `credentials` is supplied. Set false for throwaway probes.
   */
  persistTokens?: boolean;
  /** Called when a background token-persistence write fails (non-fatal). */
  onPersistError?: (error: Error) => void;
}

export interface AccountGmailBundle {
  oauth2Client: OAuth2Client;
  gmail: gmail_v1.Gmail;
  /** Shorthand scope names for this account (from the loaded creds, or []). */
  scopes: string[];
  /**
   * The LoadedCredentials the factory read from the loader chain, or null when
   * none were loaded (tolerated-missing file / fixture mode / pre-supplied
   * credentials). bootstrap reads this for its legacy-shadow warning + its
   * DEFAULT_SCOPES fallback (distinguishing "scopes absent" from "scopes []").
   */
  loaded: LoadedCredentials | null;
  /** True when the handle is a JSON fixture client (GMAIL_FIXTURE_MODE=1). */
  fixture: boolean;
}

/**
 * Build a Gmail handle for `accountId`. Throws AccountGmailError on any loader
 * failure. Never reads or writes the session singletons — the caller decides
 * whether the handle becomes "active".
 */
export async function buildAccountGmail(
  accountId: string | null,
  opts: BuildAccountGmailOptions = {},
): Promise<AccountGmailBundle> {
  const env = opts.env ?? process.env;

  // Fixture-mode: back the handle with the JSON-driven fake client for this
  // account dir. The OAuth2Client is stubbed to throw on access — production
  // code MUST NOT depend on it under fixture mode.
  if (env.GMAIL_FIXTURE_MODE === "1") {
    const fixtureDir = env.GMAIL_FIXTURE_DIR ?? "./fixtures/gmail";
    const { loadFixtureGmail } = await import("../fixtures/loader.js");
    let bundle: Awaited<ReturnType<typeof loadFixtureGmail>>;
    try {
      bundle = loadFixtureGmail(fixtureDir, accountId);
    } catch (err) {
      throw new AccountGmailError("fixture", (err as Error).message, err);
    }
    return {
      oauth2Client: makeStubOAuthClient(),
      gmail: bundle.gmail,
      scopes: bundle.scopes,
      loaded: null,
      fixture: true,
    };
  }

  let keys: ReturnType<typeof loadOAuthKeys>;
  try {
    keys = loadOAuthKeys({
      oauthPath: getOAuthPath(env),
      cwd: process.cwd(),
      configDir: getConfigDir(env),
      accountId: accountId ?? undefined,
      env,
    });
  } catch (err) {
    throw new AccountGmailError("oauth-keys", (err as Error).message, err);
  }

  const oauth2Client = new OAuth2Client(keys.client_id, keys.client_secret, OAUTH_CALLBACK);

  // Pre-supplied credentials (verifier path): use verbatim, no persistence.
  // Scopes absent (not merely empty) → read-only fallback: we cannot prove
  // write access was granted, so the handle is least-privilege.
  if (opts.credentials) {
    oauth2Client.setCredentials(opts.credentials.tokens);
    return {
      oauth2Client,
      gmail: google.gmail({ version: "v1", auth: oauth2Client }),
      scopes: opts.credentials.scopes ?? READONLY_FALLBACK_SCOPES,
      loaded: null,
      fixture: false,
    };
  }

  const requireCredentials = opts.requireCredentials ?? true;
  let loaded: LoadedCredentials;
  try {
    loaded = await loadCredentials({
      env,
      accountId: accountId ?? undefined,
      fallbackPath: opts.fallbackPath,
    });
  } catch (err) {
    // Tolerated: no credentials file yet (first-time auth bootstrap). Return a
    // bare client so the OAuth flow can mint tokens. Only a MISSING file is
    // tolerated — malformed JSON / env-json / 1Password failures still throw.
    if (!requireCredentials && err instanceof CredentialLoadError && err.source === "file") {
      return {
        oauth2Client,
        gmail: google.gmail({ version: "v1", auth: oauth2Client }),
        scopes: [],
        loaded: null,
        fixture: false,
      };
    }
    throw new AccountGmailError("credentials", (err as Error).message, err);
  }

  oauth2Client.setCredentials(loaded.credentials.tokens);
  if (opts.persistTokens !== false) {
    attachTokenPersistence(oauth2Client, loaded, { onError: opts.onPersistError });
  }
  return {
    oauth2Client,
    gmail: google.gmail({ version: "v1", auth: oauth2Client }),
    // Scopes absent (not merely empty) → read-only fallback. An explicit []
    // stays [] — callers distinguish "unknown" from "known-empty".
    scopes: loaded.credentials.scopes ?? READONLY_FALLBACK_SCOPES,
    loaded,
    fixture: false,
  };
}

/** OAuth2Client stand-in for fixture mode — throws if any method is accessed. */
function makeStubOAuthClient(): OAuth2Client {
  return new Proxy({} as OAuth2Client, {
    get: () => {
      throw new Error(
        "OAuth2Client is stubbed in fixture mode — production code MUST NOT depend on it.",
      );
    },
  });
}
