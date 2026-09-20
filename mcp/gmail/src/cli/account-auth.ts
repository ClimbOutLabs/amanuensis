// Account-oriented OAuth command runner.
//
// `gmail account auth [id]` is the canonical CLI entrypoint. This module owns
// CLI orchestration around scope resolution, path selection, OAuth flow, and
// manifest stamping; the transport-agnostic OAuth helpers stay in
// src/core/auth-flow.ts.

import fs from "node:fs";
import { resolveScopes } from "../auth-scopes.js";
import { checkAndCacheAccountAuthStatusLive } from "../core/account-status.js";
import { addAccount, getAccountCredentialsPath, validateAccountId } from "../core/accounts.js";
import {
  createOAuthClient,
  findAvailablePort,
  formatCredentialsForExport,
  loadOAuthKeys,
  runOAuthFlow,
  saveCredentialsToFile,
} from "../core/auth-flow.js";
import { getConfigDir, getCredentialsPath, getOAuthPath } from "../core/config-paths.js";

export interface AccountAuthCommandOptions {
  scopes?: string;
  nonInteractive?: boolean;
  headless?: boolean;
  callback?: string;
  port?: number;
  oauthPath?: string;
  credentialsPath?: string;
  printJson?: boolean;
  account?: string;
}

export async function runAccountAuthCommand(options: AccountAuthCommandOptions): Promise<void> {
  const fakeArgv: string[] = [];
  if (options.scopes) fakeArgv.push(`--scopes=${options.scopes}`);
  if (options.nonInteractive) fakeArgv.push("--non-interactive");

  const resolved = await resolveScopes({
    argv: fakeArgv,
    env: process.env,
  });
  process.stderr.write(
    `Using scopes (source: ${resolved.source}): ${resolved.scopes.join(", ")}\n`,
  );

  const env = process.env;
  const configDir = getConfigDir(env);
  const defaultOAuthPath = getOAuthPath(env);
  const defaultCredentialsPath = getCredentialsPath(env);

  const accountId =
    options.account ??
    (env.GMAIL_ACCOUNT && env.GMAIL_ACCOUNT.trim().length > 0
      ? env.GMAIL_ACCOUNT.trim()
      : undefined);
  if (accountId) validateAccountId(accountId);

  const oauthPath = options.oauthPath ?? env.GMAIL_OAUTH_PATH ?? defaultOAuthPath;
  const credentialsPath =
    options.credentialsPath ??
    env.GMAIL_CREDENTIALS_PATH ??
    (accountId ? getAccountCredentialsPath(accountId, env) : defaultCredentialsPath);

  if (accountId) {
    process.stderr.write(`Authenticating account: ${accountId}\n`);
  }

  const keys = loadOAuthKeys({
    oauthPath,
    cwd: process.cwd(),
    configDir,
    accountId,
  });

  let resolvedPort = options.port;
  let resolvedCallback = options.callback;
  if (options.port === undefined && options.callback === undefined) {
    const chosen = await findAvailablePort(3000);
    if (chosen !== 3000) {
      process.stderr.write(
        `Port 3000 is in use; using port ${chosen} instead for the OAuth callback.\n`,
      );
    }
    resolvedPort = chosen;
    resolvedCallback = `http://localhost:${chosen}/oauth2callback`;
  }

  const oauth2Client = createOAuthClient(keys, resolvedCallback);
  const result = await runOAuthFlow(oauth2Client, resolved.scopes, {
    callback: resolvedCallback,
    port: resolvedPort,
    headless: options.headless ?? false,
    log: (line) => process.stderr.write(`${line}\n`),
  });

  if (options.printJson) {
    // Prominent warning: this emits LIVE OAuth credentials (refresh token)
    // to stdout. Anyone holding this output can access the Gmail account —
    // never paste it into chat, logs, tickets, or shell history. Prefer the
    // default file-based storage unless you are piping into a secret store.
    process.stderr.write(
      "WARNING: --print-json writes live Gmail OAuth credentials (including the refresh token) to stdout.\n" +
        "Treat this output as a password: do not paste it into chat, logs, or issue trackers.\n",
    );
    const credentialsJson = formatCredentialsForExport(result.tokens, result.scopes);
    let keysJson: string | null = null;
    try {
      keysJson = fs.readFileSync(oauthPath, "utf8").trim();
    } catch {
      if (process.env.GMAIL_OAUTH_KEYS_JSON) keysJson = process.env.GMAIL_OAUTH_KEYS_JSON;
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          GMAIL_OAUTH_KEYS_JSON: keysJson,
          GMAIL_CREDENTIALS_JSON: credentialsJson,
        },
        null,
        2,
      )}\n`,
    );
    process.stderr.write(
      "\nFully env-driven config printed to stdout. Pipe into your host config:\n",
    );
    process.stderr.write(
      "  Add both keys to your `.mcp.json` env block, or to GH Actions secrets, or to 1Password.\n",
    );
    process.stderr.write(
      "  GMAIL_OAUTH_KEYS_JSON   = the OAuth client keys (from Google Cloud Console)\n",
    );
    process.stderr.write("  GMAIL_CREDENTIALS_JSON  = the access/refresh tokens (just minted)\n");
    process.stderr.write(
      "Either env var unblocks the matching loader; together they remove the need for ~/.gmail-mcp/.\n",
    );
    return;
  }

  saveCredentialsToFile({
    path: credentialsPath,
    tokens: result.tokens,
    scopes: result.scopes,
    configDir,
  });
  process.stderr.write(`\nCredentials saved to ${credentialsPath}\n`);

  if (accountId) {
    addAccount(accountId, { scopes: result.scopes, updatedAt: new Date().toISOString() }, env);
    const status = await checkAndCacheAccountAuthStatusLive(accountId, { env });
    if (status.emailAddress) {
      process.stderr.write(`Verified Gmail address: ${status.emailAddress}\n`);
    } else if (status.status !== "ok") {
      process.stderr.write(`Account auth status: ${status.status} - ${status.message}\n`);
    }
    process.stderr.write(`Account "${accountId}" added to the manifest.\n`);
  }
}
