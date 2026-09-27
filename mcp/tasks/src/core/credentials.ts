// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
// Credential loader chain for the tasks MCP server.
//
// Resolution order (first hit wins):
//   1. TASKS_CREDENTIALS_JSON env var - raw JSON string of {tokens, scopes}.
//      Designed for CI secrets and Docker: the harness injects the Google
//      OAuth tokens the same way it injects any secret.
//   2. TASKS_CREDENTIALS_OP env var   - 1Password secret reference like
//      "op://Personal/tasks-mcp/credentials". Shells out to `op read`.
//   3. TASKS_CREDENTIALS_PATH file    - explicit override. Without it,
//      credentials resolve to <configDir>/credentials.json.
//
// Why three sources: the OAuth flow needs a browser, so the usual pattern is
// "auth on a laptop, transfer credentials to the server". Env-var injection
// (1) and 1Password (2) both serve that pattern.

import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { getCredentialsPath } from "./config-paths.js";

const execFileAsync = promisify(execFile);

export interface StoredCredentials {
  /** Google OAuth tokens (whatever google-auth-library returns). */
  tokens: Record<string, unknown>;
  /** Shorthand scope names like "tasks". May be missing on legacy creds. */
  scopes?: string[];
}

export type CredentialSource = "env-json" | "1password" | "file";

export interface LoadedCredentials {
  credentials: StoredCredentials;
  source: CredentialSource;
  /** For "1password" / "file", the locator string (op:// URL or file path). */
  locator?: string;
}

interface TokenEmitter {
  on(event: "tokens", listener: (tokens: unknown) => void): unknown;
}

export interface TokenPersistenceOptions {
  writeFile?: typeof fs.writeFileSync;
  rename?: typeof fs.renameSync;
  chmod?: typeof fs.chmodSync;
  onError?: (error: Error) => void;
}

/** Persist google-auth-library token rotations only for file-backed credentials. */
export function attachTokenPersistence(
  oauth2Client: TokenEmitter,
  loaded: LoadedCredentials,
  options: TokenPersistenceOptions = {},
): boolean {
  if (loaded.source !== "file" || !loaded.locator) return false;

  const writeFile = options.writeFile ?? fs.writeFileSync;
  const rename = options.rename ?? fs.renameSync;
  const chmod = options.chmod ?? fs.chmodSync;
  const onError = options.onError ?? (() => undefined);
  const credentialsPath = loaded.locator;

  oauth2Client.on("tokens", (tokens: unknown) => {
    try {
      const newTokens = tokens as Record<string, unknown>;
      const mergedTokens = { ...loaded.credentials.tokens, ...newTokens };
      if (!newTokens.refresh_token && loaded.credentials.tokens.refresh_token) {
        mergedTokens.refresh_token = loaded.credentials.tokens.refresh_token;
      }
      loaded.credentials.tokens = mergedTokens;

      const tempPath = `${credentialsPath}.${process.pid}.tmp`;
      writeFile(
        tempPath,
        JSON.stringify({ tokens: mergedTokens, scopes: loaded.credentials.scopes }, null, 2),
        { mode: 0o600 },
      );
      rename(tempPath, credentialsPath);
      if (process.platform !== "win32") chmod(credentialsPath, 0o600);
    } catch (error) {
      onError(error as Error);
    }
  });
  return true;
}

export class CredentialLoadError extends Error {
  source: CredentialSource;
  cause?: unknown;
  constructor(source: CredentialSource, message: string, cause?: unknown) {
    super(message);
    this.name = "CredentialLoadError";
    this.source = source;
    cause !== undefined && (this.cause = cause);
  }
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  /** Override file path when TASKS_CREDENTIALS_PATH isn't set. */
  fallbackPath?: string;
  /** Injectable for tests. */
  readFile?: (p: string, enc: BufferEncoding) => string;
  fileExists?: (p: string) => boolean;
  runOp?: (ref: string) => Promise<string>;
}

const DEFAULT_RUN_OP = async (ref: string): Promise<string> => {
  const { stdout } = await execFileAsync("op", ["read", ref], {
    env: { ...process.env },
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

function parseStoredCredentials(raw: string, source: CredentialSource): StoredCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CredentialLoadError(
      source,
      `Failed to parse credentials JSON: ${(err as Error).message}`,
      err,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CredentialLoadError(source, "Credentials JSON must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  if ("tokens" in obj && obj.tokens && typeof obj.tokens === "object") {
    return {
      tokens: obj.tokens as Record<string, unknown>,
      scopes: Array.isArray(obj.scopes) ? (obj.scopes as string[]) : undefined,
    };
  }
  // Legacy shape: the whole object is the token set.
  return { tokens: obj };
}

export async function loadCredentials(opts: LoadOptions = {}): Promise<LoadedCredentials> {
  const env = opts.env ?? process.env;
  const readFile = opts.readFile ?? ((p, e) => fs.readFileSync(p, e));
  const fileExists = opts.fileExists ?? ((p) => fs.existsSync(p));
  const runOp = opts.runOp ?? DEFAULT_RUN_OP;

  // 1. Env JSON
  const envJson = env.TASKS_CREDENTIALS_JSON;
  if (envJson && envJson.trim().length > 0) {
    return {
      credentials: parseStoredCredentials(envJson, "env-json"),
      source: "env-json",
    };
  }

  // 2. 1Password
  const opRef = env.TASKS_CREDENTIALS_OP;
  if (opRef && opRef.trim().length > 0) {
    if (!opRef.startsWith("op://")) {
      throw new CredentialLoadError(
        "1password",
        `TASKS_CREDENTIALS_OP must be a 1Password secret reference (op://...), got: ${opRef}`,
      );
    }
    let out: string;
    try {
      out = await runOp(opRef);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new CredentialLoadError(
          "1password",
          "`op` CLI not found on PATH. Install 1Password CLI and run `op signin`.",
          err,
        );
      }
      throw new CredentialLoadError(
        "1password",
        `op read ${opRef} failed: ${(err as Error).message}`,
        err,
      );
    }
    return {
      credentials: parseStoredCredentials(out, "1password"),
      source: "1password",
      locator: opRef,
    };
  }

  // 3. File
  const credPath = env.TASKS_CREDENTIALS_PATH?.trim() || opts.fallbackPath || getCredentialsPath(env);
  if (!fileExists(credPath)) {
    throw new CredentialLoadError(
      "file",
      `Credentials file not found: ${credPath}. Run \`tasks-mcp auth\` to create it.`,
    );
  }
  const raw = readFile(credPath, "utf8");
  return {
    credentials: parseStoredCredentials(raw, "file"),
    source: "file",
    locator: credPath,
  };
}
