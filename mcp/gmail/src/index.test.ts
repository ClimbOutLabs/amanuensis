// Tests for the bootstrap orchestration layer: bootstrapSession() and the
// thin main() wrapper. Validates:
//   - bootstrapSession THROWS BootstrapError on credential failures (does NOT
//     exit the process — the TUI needs this to render its own error UI).
//   - Happy path returns a fully-populated SessionBundle.
//   - The watchdog/shutdown-handlers contract: bootstrapSession does NOT
//     register any process-level signal handlers. main() does (Step 5).
//   - main() still exits with code 1 when bootstrap throws — preserves CLI
//     and `gmail mcp` exit semantics.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests as resetSession } from "./core/session.js";
import { _resetDispatcherForTests, BootstrapError, bootstrapSession, main } from "./index.js";

let tmpDir: string;
let originalEnv: typeof process.env;

const VALID_KEYS = JSON.stringify({
  installed: { client_id: "test-id", client_secret: "test-secret" },
});
const VALID_CREDS = JSON.stringify({
  tokens: { access_token: "atok", refresh_token: "rtok" },
  scopes: ["gmail.modify"],
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-bootstrap-"));
  originalEnv = { ...process.env };
  // Scrub any inherited credential env so the test is hermetic.
  for (const k of [
    "GMAIL_CONFIG_DIR",
    "GMAIL_ACCOUNT",
    "GMAIL_CREDENTIALS_JSON",
    "GMAIL_CREDENTIALS_OP",
    "GMAIL_CREDENTIALS_PATH",
    "GMAIL_OAUTH_KEYS_JSON",
    "GMAIL_OAUTH_PATH",
  ]) {
    delete process.env[k];
  }
  process.env.GMAIL_CONFIG_DIR = tmpDir;
  resetSession();
  _resetDispatcherForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.env = originalEnv;
  resetSession();
  _resetDispatcherForTests();
});

describe("bootstrapSession — happy path", () => {
  it("returns a SessionBundle when keys + credentials are present on disk", async () => {
    fs.writeFileSync(path.join(tmpDir, "gcp-oauth.keys.json"), VALID_KEYS);
    fs.writeFileSync(path.join(tmpDir, "credentials.json"), VALID_CREDS);

    const bundle = await bootstrapSession();
    expect(bundle.oauth2Client).toBeDefined();
    expect(bundle.gmail).toBeDefined();
    expect(bundle.authorizedScopes).toEqual(["gmail.modify"]);
    expect(bundle.accountId).toBe("default"); // legacy-implicit
    expect(bundle.server).toBeDefined();
    expect(typeof bundle.dispatch).toBe("function");
  });

  it("returns a bundle even when credentials file is missing (auth subcommand bootstrap)", async () => {
    fs.writeFileSync(path.join(tmpDir, "gcp-oauth.keys.json"), VALID_KEYS);
    // No credentials.json — should NOT throw (this is the first-time account auth bootstrap path).

    const bundle = await bootstrapSession();
    expect(bundle).toBeDefined();
    expect(bundle.authorizedScopes.length).toBeGreaterThan(0); // falls back to DEFAULT_SCOPES
  });

  it("works in env-driven mode without any filesystem state", async () => {
    process.env.GMAIL_OAUTH_KEYS_JSON = VALID_KEYS;
    process.env.GMAIL_CREDENTIALS_JSON = VALID_CREDS;

    const bundle = await bootstrapSession();
    expect(bundle.accountId).toBeNull(); // no manifest, env-driven → no account name
    expect(bundle.authorizedScopes).toEqual(["gmail.modify"]);
  });
});

describe("bootstrapSession — error surfaces", () => {
  it("throws BootstrapError (does NOT exit) when OAuth keys are missing entirely", async () => {
    // No keys anywhere.
    await expect(bootstrapSession()).rejects.toBeInstanceOf(BootstrapError);
    try {
      await bootstrapSession();
    } catch (err) {
      expect(err).toBeInstanceOf(BootstrapError);
      expect((err as BootstrapError).stage).toBe("oauth-keys");
    }
  });

  it("throws BootstrapError when GMAIL_OAUTH_KEYS_JSON is malformed", async () => {
    process.env.GMAIL_OAUTH_KEYS_JSON = "{not-json";
    await expect(bootstrapSession()).rejects.toThrow(BootstrapError);
    try {
      await bootstrapSession();
    } catch (err) {
      expect((err as BootstrapError).stage).toBe("oauth-keys");
    }
  });

  it("throws BootstrapError when GMAIL_CREDENTIALS_JSON is malformed (non-file source)", async () => {
    process.env.GMAIL_OAUTH_KEYS_JSON = VALID_KEYS;
    process.env.GMAIL_CREDENTIALS_JSON = "{not-json";
    await expect(bootstrapSession()).rejects.toThrow(BootstrapError);
    try {
      await bootstrapSession();
    } catch (err) {
      expect((err as BootstrapError).stage).toBe("credentials");
    }
  });

  it("does NOT call process.exit on failure (TUI needs to render its own error)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called — bootstrap should not exit!`);
    }) as never);

    process.env.GMAIL_OAUTH_KEYS_JSON = "{bad";
    await expect(bootstrapSession()).rejects.toBeInstanceOf(BootstrapError);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("bootstrapSession — process contract", () => {
  it("does NOT install SIG* handlers (that's main()'s job)", async () => {
    fs.writeFileSync(path.join(tmpDir, "gcp-oauth.keys.json"), VALID_KEYS);
    fs.writeFileSync(path.join(tmpDir, "credentials.json"), VALID_CREDS);

    const sigOnCalls: string[] = [];
    const onSpy = vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (typeof event === "string" && event.startsWith("SIG")) sigOnCalls.push(event);
      return process.on(event, listener);
    });
    // The spy must call through so test infra (vitest's own listeners) isn't broken.
    // We're only asserting that NO SIG* handlers are added during bootstrapSession.

    await bootstrapSession();
    expect(sigOnCalls).toEqual([]);
    onSpy.mockRestore();
  });

  it("does not install process handlers when main skips transport", async () => {
    fs.writeFileSync(path.join(tmpDir, "gcp-oauth.keys.json"), VALID_KEYS);
    fs.writeFileSync(path.join(tmpDir, "credentials.json"), VALID_CREDS);

    const sigOnCalls: string[] = [];
    const onSpy = vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (typeof event === "string" && event.startsWith("SIG")) sigOnCalls.push(event);
      return process.on(event, listener);
    });

    await main({ skipTransport: true });
    expect(sigOnCalls).toEqual([]);
    onSpy.mockRestore();
  });

  it("lets skip-transport bootstrap failures propagate to the CLI runtime", async () => {
    process.env.GMAIL_OAUTH_KEYS_JSON = "{bad";
    await expect(main({ skipTransport: true })).rejects.toBeInstanceOf(BootstrapError);
  });
});
