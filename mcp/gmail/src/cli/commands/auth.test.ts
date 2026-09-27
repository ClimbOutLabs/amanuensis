// Tests for the account OAuth CLI driver (runAccountAuthCommand).
//
// Focus: the --print-json env-capture path and the disk-write path.
// `runOAuthFlow` is mocked so we don't actually open a browser / start a
// loopback server; the test asserts the JSON stdout shape and the
// {tokens, scopes} file written to disk.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the OAuth flow so runAccountAuthCommand doesn't actually start a loopback
// server. Other auth-flow exports (loadOAuthKeys, createOAuthClient,
// saveCredentialsToFile, formatCredentialsForExport, findAvailablePort) run
// real — they're cheap and deterministic with a tmp dir + explicit --port.
vi.mock("../../core/auth-flow.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../core/auth-flow.js")>("../../core/auth-flow.js");
  return {
    ...actual,
    runOAuthFlow: vi.fn(async (_client: unknown, scopes: string[]) => ({
      tokens: {
        access_token: "fake-access",
        refresh_token: "fake-refresh",
        expiry_date: 1700000000000,
      },
      scopes,
    })),
  };
});

vi.mock("../../core/account-status.js", () => ({
  checkAndCacheAccountAuthStatusLive: vi.fn(async (id: string) => ({
    id,
    status: "ok",
    message: "OAuth credentials verified with the Gmail API.",
    checkedAt: "2026-01-01T00:00:00.000Z",
    credentialsPath: "",
    emailAddress: `${id}@example.test`,
    scopes: ["gmail.send"],
  })),
}));

let tmpDir: string;
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;
let stdoutChunks: string[];
let stderrChunks: string[];
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-auth-cmd-test-"));
  stdoutChunks = [];
  stderrChunks = [];
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  // Capture writes — runAccountAuthCommand prints to both streams.
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  savedEnv = { ...process.env };
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Restore env vars we may have set.
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    process.env[k] = v;
  }
  vi.clearAllMocks();
});

function writeKeys(dir: string): string {
  const keysPath = path.join(dir, "gcp-oauth.keys.json");
  fs.writeFileSync(
    keysPath,
    JSON.stringify({
      installed: { client_id: "test-client-id", client_secret: "test-client-secret" },
    }),
  );
  return keysPath;
}

describe("runAccountAuthCommand --print-json", () => {
  it("prints {GMAIL_OAUTH_KEYS_JSON, GMAIL_CREDENTIALS_JSON} to stdout (disk-keys path)", async () => {
    const keysPath = writeKeys(tmpDir);
    const credsPath = path.join(tmpDir, "credentials.json");
    // Stop the loopback listener from binding — use an unlikely-collision port.
    // (runOAuthFlow is mocked, so the port is never bound; but runAccountAuthCommand
    // still consults --port to skip the findAvailablePort probe.)
    const { runAccountAuthCommand } = await import("../account-auth.js");
    await runAccountAuthCommand({
      scopes: "gmail.modify",
      nonInteractive: true,
      port: 45777,
      oauthPath: keysPath,
      credentialsPath: credsPath,
      printJson: true,
    });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(Object.keys(parsed).sort()).toEqual(["GMAIL_CREDENTIALS_JSON", "GMAIL_OAUTH_KEYS_JSON"]);

    // OAuth keys JSON is the verbatim disk file (trimmed).
    expect(parsed.GMAIL_OAUTH_KEYS_JSON).toBe(fs.readFileSync(keysPath, "utf8").trim());

    // Credentials JSON is canonical {tokens, scopes} JSON.
    const innerCreds = JSON.parse(parsed.GMAIL_CREDENTIALS_JSON);
    expect(innerCreds).toEqual({
      tokens: {
        access_token: "fake-access",
        refresh_token: "fake-refresh",
        expiry_date: 1700000000000,
      },
      scopes: ["gmail.modify"],
    });

    // --print-json must NOT write the credentials file to disk.
    expect(fs.existsSync(credsPath)).toBe(false);
  });

  it("falls back to GMAIL_OAUTH_KEYS_JSON env when keys file is unreadable", async () => {
    const credsPath = path.join(tmpDir, "credentials.json");
    const envJson = JSON.stringify({
      installed: { client_id: "env-id", client_secret: "env-secret" },
    });
    process.env.GMAIL_OAUTH_KEYS_JSON = envJson;
    const { runAccountAuthCommand } = await import("../account-auth.js");
    await runAccountAuthCommand({
      scopes: "gmail.readonly",
      nonInteractive: true,
      port: 45778,
      // oauthPath points at a nonexistent path — keys come from the env var,
      // and the --print-json branch should re-emit that env var verbatim
      // since the file read fails.
      oauthPath: path.join(tmpDir, "nope.json"),
      credentialsPath: credsPath,
      printJson: true,
    });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.GMAIL_OAUTH_KEYS_JSON).toBe(envJson);
    expect(JSON.parse(parsed.GMAIL_CREDENTIALS_JSON)).toEqual({
      tokens: {
        access_token: "fake-access",
        refresh_token: "fake-refresh",
        expiry_date: 1700000000000,
      },
      scopes: ["gmail.readonly"],
    });
    expect(fs.existsSync(credsPath)).toBe(false);
  });

  it("without --print-json, writes credentials to disk and emits no stdout JSON", async () => {
    const keysPath = writeKeys(tmpDir);
    const credsPath = path.join(tmpDir, "credentials.json");
    const { runAccountAuthCommand } = await import("../account-auth.js");
    await runAccountAuthCommand({
      scopes: "gmail.send",
      nonInteractive: true,
      port: 45779,
      oauthPath: keysPath,
      credentialsPath: credsPath,
    });

    // No JSON on stdout.
    expect(stdoutChunks.join("")).toBe("");
    // Credentials file written with canonical shape.
    expect(fs.existsSync(credsPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(credsPath, "utf8"));
    expect(written).toEqual({
      tokens: {
        access_token: "fake-access",
        refresh_token: "fake-refresh",
        expiry_date: 1700000000000,
      },
      scopes: ["gmail.send"],
    });
    // Confirmation line goes to stderr.
    expect(stderrChunks.join("")).toContain("Credentials saved");
  });

  it("creates the missing per-account credentials directory before writing named-account credentials", async () => {
    const keysPath = writeKeys(tmpDir);
    process.env.GMAIL_CONFIG_DIR = tmpDir;
    const accountCredsPath = path.join(tmpDir, "accounts", "work", "credentials.json");
    expect(fs.existsSync(path.dirname(accountCredsPath))).toBe(false);

    const { runAccountAuthCommand } = await import("../account-auth.js");
    const { checkAndCacheAccountAuthStatusLive } = await import("../../core/account-status.js");
    await runAccountAuthCommand({
      account: "work",
      scopes: "gmail.send",
      nonInteractive: true,
      port: 45780,
      oauthPath: keysPath,
    });

    expect(fs.existsSync(accountCredsPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(accountCredsPath, "utf8"));
    expect(written.scopes).toEqual(["gmail.send"]);
    expect(checkAndCacheAccountAuthStatusLive).toHaveBeenCalledWith("work", {
      env: process.env,
    });
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, "accounts.json"), "utf8"))).toEqual({
      defaultAccount: "work",
      accounts: {
        work: expect.objectContaining({
          scopes: ["gmail.send"],
        }),
      },
    });
  });
});
