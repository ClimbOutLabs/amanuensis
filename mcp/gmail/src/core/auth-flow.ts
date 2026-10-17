// OAuth2 authentication flow for Gmail-MCP-Server.
//
// Drives the `gmail account auth` CLI subcommand.
// Implements the loopback-IP redirect pattern that's the only flow Google
// supports for installed/desktop clients today (OOB was deprecated in 2022).
//
// Headless / remote-server pattern: there is no first-class headless flow
// for personal Gmail. Two workarounds, documented in README:
//   a) SSH local port-forward — run the flow on the server, tunnel
//      localhost:3000 back to the user's laptop browser.
//   b) Auth on a laptop, transfer ~/.gmail-mcp/accounts/<id>/credentials.json
//      to the server (or set GMAIL_CREDENTIALS_JSON / GMAIL_CREDENTIALS_OP).

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { OAuth2Client } from "google-auth-library";
import open from "open";
import { scopeNamesToUrls } from "../scopes.js";
import { getAccountOAuthPath, validateAccountId } from "./accounts.js";

const DEFAULT_CALLBACK = "http://localhost:3000/oauth2callback";
const DEFAULT_PORT = 3000;

/**
 * Check whether a TCP port is free on `host`. Resolves true on success,
 * false on EADDRINUSE / EACCES. Closes the probe socket immediately.
 */
function probePort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      resolve(!(code === "EADDRINUSE" || code === "EACCES"));
    });
    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, host);
  });
}

/**
 * Try `preferredPort` first; on conflict, walk the next few ports; if all
 * are taken, let the OS pick an ephemeral one. Used by `gmail account auth` so a
 * busy port 3000 (a common collision with dev servers) doesn't crash the
 * flow.
 */
export async function findAvailablePort(
  preferredPort: number,
  host: string = "127.0.0.1",
): Promise<number> {
  if (await probePort(preferredPort, host)) return preferredPort;
  for (let i = 1; i <= 10; i++) {
    if (await probePort(preferredPort + i, host)) return preferredPort + i;
  }
  // Ephemeral fallback — OS picks any free port.
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.once("listening", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr && typeof addr.port === "number") {
        const p = addr.port;
        server.close(() => {
          resolve(p);
        });
      } else {
        reject(new Error("Could not determine ephemeral port"));
      }
    });
    server.listen(0, host);
  });
}

export interface OAuthKeys {
  client_id: string;
  client_secret: string;
  // The "type" of OAuth client (installed / web). We don't enforce it here
  // but Google issues different consent flows for each.
}

export interface OAuthFlowOptions {
  callback?: string;
  port?: number;
  headless?: boolean; // true → skip browser launch, just print URL
  // Where to print human-facing messages. Stderr by default so stdout stays
  // clean for JSON output / piping.
  log?: (line: string) => void;
}

export interface OAuthFlowResult {
  tokens: Record<string, unknown>;
  scopes: string[];
}

export interface LoadKeysOptions {
  // Path to gcp-oauth.keys.json on disk. Used as the fallback when env-driven
  // keys aren't set. Required for the `gmail account auth` flow's first run.
  oauthPath: string;
  cwd?: string; // for the "found in current directory" copy convenience
  configDir?: string; // where to copy local keys to
  // Inject env for tests; defaults to process.env.
  env?: NodeJS.ProcessEnv;
  /**
   * Account id. When supplied AND <configDir>/accounts/<id>/gcp-oauth.keys.json
   * exists, that file wins over the shared `oauthPath`. Enables per-account
   * OAuth client keys for users who don't share a single Google Cloud project
   * across their Gmail accounts (e.g. CI / multi-tenant). When omitted, only
   * the shared `oauthPath` is consulted.
   */
  accountId?: string;
}

/**
 * Parse a JSON blob that came from GMAIL_OAUTH_KEYS_JSON. Accepts the same
 * three shapes Google emits + a bare {client_id, client_secret} for users who
 * don't want to inline the whole Google Cloud Console JSON.
 */
function parseOAuthKeysJson(raw: string, sourceLabel: string): OAuthKeys {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid ${sourceLabel}: ${(err as Error).message}`, { cause: err });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid ${sourceLabel}: must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const inner =
    (obj.installed as Record<string, unknown> | undefined) ??
    (obj.web as Record<string, unknown> | undefined) ??
    obj;
  const client_id = inner?.client_id as string | undefined;
  const client_secret = inner?.client_secret as string | undefined;
  if (!client_id || !client_secret) {
    throw new Error(
      `Invalid ${sourceLabel}: must contain client_id and client_secret (either at the root, or under "installed"/"web").`,
    );
  }
  return { client_id, client_secret };
}

/**
 * Load OAuth client keys. Resolution order:
 *   1. GMAIL_OAUTH_KEYS_JSON env var — full inline. Lets a deployment run with
 *      no filesystem state (Docker / Cloud Run / .mcp.json env block).
 *   2. Disk at `oauthPath` — the historical default. Honors the legacy "drop
 *      gcp-oauth.keys.json into the cwd and we'll copy it to the config dir"
 *      convenience for first-time users.
 */
export function loadOAuthKeys(opts: LoadKeysOptions): OAuthKeys {
  const { oauthPath, cwd, configDir, accountId } = opts;
  const env = opts.env ?? process.env;

  // 1. Env-inline keys
  const envJson = env.GMAIL_OAUTH_KEYS_JSON;
  if (envJson && envJson.trim().length > 0) {
    return parseOAuthKeysJson(envJson, "GMAIL_OAUTH_KEYS_JSON");
  }

  // 2. Per-account override: <configDir>/accounts/<id>/gcp-oauth.keys.json,
  //    if it exists, beats the shared file. Lets CI/multi-tenant deployments
  //    bind a distinct OAuth client per account.
  if (accountId) {
    validateAccountId(accountId);
    const perAccount = getAccountOAuthPath(accountId, env);
    if (fs.existsSync(perAccount)) {
      return parseOAuthKeysJson(
        fs.readFileSync(perAccount, "utf8"),
        `OAuth keys file ${perAccount}`,
      );
    }
  }

  // 3. Copy from cwd if found there and we have a target (legacy convenience).
  if (cwd && configDir) {
    const localPath = path.join(cwd, "gcp-oauth.keys.json");
    if (fs.existsSync(localPath) && !fs.existsSync(oauthPath)) {
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      }
      fs.copyFileSync(localPath, oauthPath);
      fs.chmodSync(oauthPath, 0o600);
    }
  }

  // 4. Shared disk path
  if (!fs.existsSync(oauthPath)) {
    throw new Error(
      `OAuth keys not found. Set GMAIL_OAUTH_KEYS_JSON env var with the JSON contents, or place gcp-oauth.keys.json at ${oauthPath} (or in the current directory).`,
    );
  }
  return parseOAuthKeysJson(fs.readFileSync(oauthPath, "utf8"), `OAuth keys file ${oauthPath}`);
}

export function createOAuthClient(
  keys: OAuthKeys,
  callback: string = DEFAULT_CALLBACK,
): OAuth2Client {
  validateLoopbackCallback(callback);
  return new OAuth2Client(keys.client_id, keys.client_secret, callback);
}

/**
 * The only hostnames a loopback OAuth callback may use. Anything else would
 * send the authorization code to a non-local server (open-redirector /
 * token-theft risk), so it is rejected outright.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function validateLoopbackCallback(callback: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(callback);
  } catch {
    throw new Error(`Invalid OAuth callback URL: ${callback}`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error(
      `OAuth callback URL must use http:// because the built-in loopback listener does not support TLS (got ${parsed.protocol}//).`,
    );
  }
  // WHATWG URL keeps brackets on IPv6 literals ("[::1]") — strip them before
  // comparing so http://[::1]:port/ callbacks validate.
  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `OAuth callback URL must target a loopback host (localhost, 127.0.0.1, or ::1); got "${parsed.hostname}". ` +
        `A non-loopback callback would deliver the authorization code to a remote server.`,
    );
  }
  return parsed;
}

/**
 * Run the loopback-IP OAuth flow. Starts a local HTTP server on `port`,
 * generates the consent URL, opens it in the browser (unless headless), and
 * resolves with the tokens once the callback fires. Errors out cleanly on
 * timeout, denied consent, or callback failure.
 */
export async function runOAuthFlow(
  oauth2Client: OAuth2Client,
  scopes: string[],
  options: OAuthFlowOptions = {},
): Promise<OAuthFlowResult> {
  const callback = options.callback ?? DEFAULT_CALLBACK;
  validateLoopbackCallback(callback);
  const port = options.port ?? portFromCallback(callback) ?? DEFAULT_PORT;
  const headless = options.headless ?? false;
  const log = options.log ?? ((line: string) => {
    console.error(line);
  });

  const scopeUrls = scopeNamesToUrls(scopes);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopeUrls,
  });

  log(`Requesting scopes: ${scopes.join(", ")}`);
  log("");
  if (headless) {
    log("Headless mode: not launching a browser. Open this URL on a machine with a browser:");
    log("");
    log(`  ${authUrl}`);
    log("");
    log("If running on a remote server with no local browser, you have two options:");
    log("  1. SSH port-forward:  ssh -L 3000:localhost:3000 your-server");
    log("     then open the URL above in your laptop browser. The callback will tunnel back.");
    log(
      "  2. Auth locally on a laptop, then transfer ~/.gmail-mcp/accounts/<id>/credentials.json to the server",
    );
    log("     (or set GMAIL_CREDENTIALS_JSON / GMAIL_CREDENTIALS_OP env vars).");
    log("");
  } else {
    log("Opening this URL in your browser to authenticate:");
    log("");
    log(`  ${authUrl}`);
    log("");
  }

  const server = http.createServer();
  return new Promise<OAuthFlowResult>((resolve, reject) => {
    const cleanup = () => {
      try {
        server.close();
      } catch {
        /* swallow */
      }
    };

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });

    const onRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
      try {
        if (!req.url?.startsWith("/oauth2callback")) {
          res.writeHead(404);
          res.end();
          return;
        }
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        const code = url.searchParams.get("code");
        const errParam = url.searchParams.get("error");
        if (errParam) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(renderErrorPage(`OAuth consent denied: ${errParam}`));
          cleanup();
          reject(new Error(`OAuth consent denied: ${errParam}`));
          return;
        }
        if (!code) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(renderErrorPage("Missing authorization code in callback URL."));
          cleanup();
          reject(new Error("Missing authorization code in callback URL"));
          return;
        }
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderSuccessPage(scopes));
        cleanup();
        resolve({ tokens: tokens as unknown as Record<string, unknown>, scopes });
      } catch (err) {
        try {
          res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
          res.end(renderErrorPage(err instanceof Error ? err.message : "Authentication failed."));
        } catch {
          /* ignore */
        }
        cleanup();
        reject(err instanceof Error ? err : new Error("OAuth callback failed", { cause: err }));
      }
    };
    server.on("request", (req, res) => {
      void onRequest(req, res);
    });

    server.listen(port, "127.0.0.1", () => {
      if (!headless) {
        // Best-effort browser open. Failures are non-fatal — user can copy.
        open(authUrl).catch(() => {
          log("(Could not auto-launch a browser. Copy the URL above instead.)");
        });
      }
    });
  });
}

export interface SaveCredentialsOptions {
  path: string;
  tokens: Record<string, unknown>;
  scopes: string[];
  // mkdir with mode 0700 if config dir missing.
  configDir?: string;
}

export function saveCredentialsToFile(opts: SaveCredentialsOptions): void {
  if (opts.configDir && !fs.existsSync(opts.configDir)) {
    fs.mkdirSync(opts.configDir, { recursive: true, mode: 0o700 });
  }
  const targetDir = path.dirname(opts.path);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  }
  const payload = JSON.stringify({ tokens: opts.tokens, scopes: opts.scopes }, null, 2);
  fs.writeFileSync(opts.path, payload, { mode: 0o600 });
  // writeFileSync applies the mode only when it creates the file; re-auth over an older file must tighten it.
  fs.chmodSync(opts.path, 0o600);
}

/**
 * Format credentials for upload to a secret store (GH Actions, 1Password,
 * Doppler, Vault, etc.). Returns the same JSON shape as saveCredentialsToFile
 * writes to disk, suitable as the value of `GMAIL_CREDENTIALS_JSON`.
 */
export function formatCredentialsForExport(
  tokens: Record<string, unknown>,
  scopes: string[],
): string {
  return JSON.stringify({ tokens, scopes });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_STYLES = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background: #0f1115; color: #e6edf3; margin: 0; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { max-width: 460px; width: 100%; background: #161b22; border: 1px solid #30363d;
          border-radius: 12px; padding: 36px 32px; text-align: center;
          box-shadow: 0 12px 40px rgba(0,0,0,0.45); }
  .icon { font-size: 56px; line-height: 1; margin-bottom: 16px; }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 6px 0; color: #9da7b3; font-size: 14px; line-height: 1.5; }
  .scopes { margin: 18px 0 6px; display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
  .scope { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
           background: #21262d; color: #d2a8ff; padding: 4px 10px; border-radius: 999px; }
  .footnote { margin-top: 22px; font-size: 12px; color: #6e7681; }
  .ok h1 { color: #3fb950; }
  .err .icon { color: #f85149; }
  .err h1 { color: #f85149; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
         background: #21262d; padding: 2px 6px; border-radius: 4px; color: #e6edf3; }
`;

function renderSuccessPage(scopes: string[]): string {
  const chips = scopes.map((s) => `<span class="scope">${escapeHtml(s)}</span>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Authentication successful · gmail</title>
<style>${PAGE_STYLES}</style></head>
<body><div class="card ok">
  <div class="icon">✓</div>
  <h1>Authentication successful</h1>
  <p>Credentials have been saved. You can return to the terminal.</p>
  <div class="scopes">${chips}</div>
  <p class="footnote">This tab will close automatically in a moment.</p>
</div>
<script>setTimeout(function(){ try { window.close(); } catch (_) { /* ignore */ } }, 1500);</script>
</body></html>`;
}

function renderErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Authentication failed · gmail</title>
<style>${PAGE_STYLES}</style></head>
<body><div class="card err">
  <div class="icon">✗</div>
  <h1>Authentication failed</h1>
  <p>${escapeHtml(message)}</p>
  <p class="footnote">You can close this tab and re-run <code>gmail account auth</code>.</p>
</div></body></html>`;
}

// Exported for unit tests; not part of the public auth-flow surface.
export const _testing = { renderSuccessPage, renderErrorPage };

function portFromCallback(callback: string): number | null {
  try {
    const parsed = new URL(callback);
    if (parsed.port) return Number(parsed.port);
    if (parsed.protocol === "https:") return 443;
    if (parsed.protocol === "http:") return 80;
    return null;
  } catch {
    return null;
  }
}
