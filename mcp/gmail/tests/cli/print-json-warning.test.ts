// Security #6: `account auth --print-json` warns that its output is live
// OAuth credentials and must be treated as a password.
//
// The warning appears in two places: the --print-json help text (captured
// in-process from the commander program) and the runtime stderr warning
// emitted right before the credentials JSON (driven here with a mocked
// OAuth flow, mirroring src/cli/commands/auth.test.ts).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAccountCommand } from "../../src/cli/commands/account.js";

// Mock the OAuth flow so runAccountAuthCommand doesn't open a browser or
// bind a loopback server; the printJson branch still runs for real.
vi.mock("../../src/core/auth-flow.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/core/auth-flow.js")>(
      "../../src/core/auth-flow.js",
    );
  return {
    ...actual,
    runOAuthFlow: vi.fn(async (_client: unknown, scopes: string[]) => ({
      tokens: {
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        expiry_date: 1700000000000,
      },
      scopes,
    })),
  };
});

vi.mock("../../src/core/account-status.js", () => ({
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

function accountAuthHelp(): string {
  const program = new Command();
  program.addCommand(buildAccountCommand());
  const account = program.commands.find((c) => c.name() === "account");
  expect(account).toBeDefined();
  const auth = account!.commands.find((c) => c.name() === "auth");
  expect(auth).toBeDefined();
  let out = "";
  // configureOutput must be set on the subcommand itself — the parent's
  // configuration does not propagate to outputHelp().
  auth!.configureOutput({
    writeOut: (s: string) => {
      out += s;
    },
    writeErr: () => {},
  });
  auth!.outputHelp();
  return out;
}

let tmpDir: string;
let origStderrWrite: typeof process.stderr.write;
let stderrChunks: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-printjson-warn-"));
  stderrChunks = [];
  origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = origStderrWrite;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("account auth --print-json credential warning (security #6)", () => {
  it("documents the live-credential risk in the --print-json help text", () => {
    const help = accountAuthHelp();
    expect(help).toMatch(/--print-json/);
    expect(help).toMatch(/live credentials/i);
    expect(help).toMatch(/password/i);
  });

  it("emits a prominent stderr warning before printing credentials JSON", async () => {
    const keysPath = path.join(tmpDir, "gcp-oauth.keys.json");
    fs.writeFileSync(
      keysPath,
      JSON.stringify({
        installed: { client_id: "test-client-id", client_secret: "test-client-secret" },
      }),
    );
    const { runAccountAuthCommand } = await import("../../src/cli/account-auth.js");
    await runAccountAuthCommand({
      account: "warn-acct",
      scopes: "gmail.modify",
      nonInteractive: true,
      port: 45778,
      oauthPath: keysPath,
      credentialsPath: path.join(tmpDir, "credentials.json"),
      printJson: true,
    });
    const stderr = stderrChunks.join("");
    expect(stderr).toMatch(/WARNING/i);
    expect(stderr).toMatch(/live Gmail OAuth credentials/i);
    expect(stderr).toMatch(/refresh token/i);
    expect(stderr).toMatch(/as a password/i);
  });
});
