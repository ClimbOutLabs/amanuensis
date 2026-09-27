// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
// Google OAuth2 flow for the calendar MCP server.
//
// Drives `calendar-mcp auth`. Uses the loopback-IP redirect pattern (the flow
// Google supports for installed/desktop clients). Requests the minimal scope
// set from src/core/scopes.ts unless the caller passes explicit scopes.
//
// Headless / remote-server pattern: there is no first-class headless flow
// for personal Google accounts. Two workarounds, documented in README:
//   a) SSH local port-forward - run the flow on the server, tunnel
//      localhost:3000 back to the laptop browser.
//   b) Auth on a laptop, transfer <configDir>/credentials.json to the server
//      (or set CALENDAR_CREDENTIALS_JSON / CALENDAR_CREDENTIALS_OP).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { OAuth2Client } from "google-auth-library";
import { getCredentialsPath } from "./config-paths.js";
import { DEFAULT_SCOPES, scopeNamesToUrls } from "./scopes.js";

const DEFAULT_PORT = 3000;
const DEFAULT_CALLBACK_PATH = "/oauth2callback";

export interface OAuthKeys {
  client_id: string;
  client_secret: string;
}

export interface AuthFlowOptions {
  /** OAuth client keys; defaults to CALENDAR_OAUTH_KEYS_PATH or <configDir>/gcp-oauth.keys.json. */
  keysPath?: string;
  /** Scopes to request (shorthand names); defaults to DEFAULT_SCOPES. */
  scopes?: string[];
  /** Port for the loopback callback listener. */
  port?: number;
  /** When true, print the auth URL instead of assuming a browser is present. */
  headless?: boolean;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface AuthFlowResult {
  tokens: Record<string, unknown>;
  scopes: string[];
}

function readOAuthKeys(keysPath: string): OAuthKeys {
  let raw: string;
  try {
    raw = fs.readFileSync(keysPath, "utf8");
  } catch (err) {
    throw new Error(
      `OAuth client keys not found at ${keysPath}. Create a Google Cloud OAuth client ` +
        `(Desktop type), download the JSON, and save it there.`,
    );
  }
  const parsed = JSON.parse(raw) as { installed?: OAuthKeys; web?: OAuthKeys } & Partial<OAuthKeys>;
  const keys = parsed.installed ?? parsed.web ?? parsed;
  if (!keys.client_id || !keys.client_secret) {
    throw new Error(`OAuth keys at ${keysPath} are missing client_id/client_secret.`);
  }
  return { client_id: keys.client_id, client_secret: keys.client_secret };
}

/** Run the loopback OAuth flow and return the tokens plus the granted scopes. */
export async function runAuthFlow(opts: AuthFlowOptions = {}): Promise<AuthFlowResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const { getConfigDir } = await import("./config-paths.js");
  const keysPath =
    opts.keysPath ?? env.CALENDAR_OAUTH_KEYS_PATH ?? path.join(getConfigDir(env), "gcp-oauth.keys.json");
  const keys = readOAuthKeys(keysPath);
  const scopes = opts.scopes ?? DEFAULT_SCOPES;
  const port = opts.port ?? DEFAULT_PORT;
  const redirectUri = `http://localhost:${port}${DEFAULT_CALLBACK_PATH}`;

  const client = new OAuth2Client(keys.client_id, keys.client_secret, redirectUri);
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopeNamesToUrls(scopes),
  });

  log("Open this URL in your browser to authorize calendar access:");
  log(authUrl);

  const code = await waitForCallbackCode(port, log);
  const { tokens } = await client.getToken(code);
  return { tokens: tokens as Record<string, unknown>, scopes };
}

/** Persist {tokens, scopes} to the credentials file with 0600 permissions. */
export function writeCredentialsFile(
  result: AuthFlowResult,
  opts: { credentialsPath?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = opts.env ?? process.env;
  const credentialsPath = opts.credentialsPath ?? getCredentialsPath(env);
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true, mode: 0o700 });
  const tempPath = `${credentialsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, credentialsPath);
  if (process.platform !== "win32") fs.chmodSync(credentialsPath, 0o600);
  return credentialsPath;
}

function waitForCallbackCode(port: number, log: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== DEFAULT_CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" }).end(
        "<html><body><p>Authorization complete. You can close this tab.</p></body></html>",
      );
      server.close();
      if (error) reject(new Error(`OAuth error: ${error}`));
      else if (!code) reject(new Error("OAuth callback missing code parameter."));
      else resolve(code);
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      if (!process.env.CALENDAR_AUTH_HEADLESS) {
        log(`Waiting for the OAuth callback on http://localhost:${port}${DEFAULT_CALLBACK_PATH} ...`);
      }
    });
  });
}
