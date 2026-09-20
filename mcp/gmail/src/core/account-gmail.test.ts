// Unit tests for buildAccountGmail — the session-free per-account handle
// factory that bootstrap, switch_account, the live-verifier, and unread_summary
// all share. Covers fixture mode, the tolerated-missing-credentials path, the
// pre-supplied-credentials (verifier) path, and the typed stage errors.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountGmailError, buildAccountGmail } from "./account-gmail.js";

const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/gmail", import.meta.url));
const VALID_KEYS = JSON.stringify({ installed: { client_id: "cid", client_secret: "csec" } });

const ENV_KEYS = [
  "GMAIL_CONFIG_DIR",
  "GMAIL_ACCOUNT",
  "GMAIL_FIXTURE_MODE",
  "GMAIL_FIXTURE_DIR",
  "GMAIL_OAUTH_KEYS_JSON",
  "GMAIL_OAUTH_PATH",
  "GMAIL_CREDENTIALS_JSON",
  "GMAIL_CREDENTIALS_OP",
  "GMAIL_CREDENTIALS_PATH",
];

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-account-gmail-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GMAIL_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("buildAccountGmail — fixture mode", () => {
  it("returns a fixture-backed handle carrying the account's scopes", async () => {
    process.env.GMAIL_FIXTURE_MODE = "1";
    process.env.GMAIL_FIXTURE_DIR = FIXTURE_DIR;

    const bundle = await buildAccountGmail("work");
    expect(bundle.fixture).toBe(true);
    expect(bundle.scopes).toContain("gmail.modify");
    expect(bundle.gmail).toBeDefined();
    expect(bundle.loaded).toBeNull();
    // The OAuth2Client is a throwing stub — nothing may depend on it.
    expect(() => (bundle.oauth2Client as unknown as { credentials: unknown }).credentials).toThrow(
      /stubbed in fixture mode/i,
    );
  });

  it("throws AccountGmailError(stage=fixture) for an unknown fixture account", async () => {
    process.env.GMAIL_FIXTURE_MODE = "1";
    process.env.GMAIL_FIXTURE_DIR = FIXTURE_DIR;

    await expect(buildAccountGmail("does-not-exist")).rejects.toMatchObject({
      name: "AccountGmailError",
      stage: "fixture",
    });
  });
});

describe("buildAccountGmail — real mode", () => {
  it("tolerates a missing credentials file when requireCredentials is false", async () => {
    process.env.GMAIL_OAUTH_KEYS_JSON = VALID_KEYS;

    const bundle = await buildAccountGmail(null, { requireCredentials: false });
    expect(bundle.fixture).toBe(false);
    expect(bundle.loaded).toBeNull();
    expect(bundle.scopes).toEqual([]);
    expect(bundle.gmail).toBeDefined();
  });

  it("uses pre-supplied credentials verbatim without loading from disk", async () => {
    process.env.GMAIL_OAUTH_KEYS_JSON = VALID_KEYS;

    const bundle = await buildAccountGmail("acct", {
      credentials: {
        tokens: { access_token: "a", refresh_token: "r" },
        scopes: ["gmail.readonly"],
      },
    });
    expect(bundle.scopes).toEqual(["gmail.readonly"]);
    expect(bundle.loaded).toBeNull();
    expect(bundle.gmail).toBeDefined();
  });

  it("loads env-json credentials and returns their scopes + source", async () => {
    process.env.GMAIL_OAUTH_KEYS_JSON = VALID_KEYS;
    process.env.GMAIL_CREDENTIALS_JSON = JSON.stringify({
      tokens: { access_token: "a", refresh_token: "r" },
      scopes: ["gmail.modify"],
    });

    const bundle = await buildAccountGmail(null);
    expect(bundle.scopes).toEqual(["gmail.modify"]);
    expect(bundle.loaded?.source).toBe("env-json");
  });

  it("throws AccountGmailError(stage=oauth-keys) when keys are missing entirely", async () => {
    await expect(buildAccountGmail(null, { requireCredentials: false })).rejects.toMatchObject({
      name: "AccountGmailError",
      stage: "oauth-keys",
    });
  });

  it("throws AccountGmailError(stage=credentials) on malformed credentials", async () => {
    process.env.GMAIL_OAUTH_KEYS_JSON = VALID_KEYS;
    process.env.GMAIL_CREDENTIALS_JSON = "{not-json";

    await expect(buildAccountGmail(null)).rejects.toMatchObject({
      name: "AccountGmailError",
      stage: "credentials",
    });
  });

  it("exposes the AccountGmailError class shape (stage + cause)", () => {
    const err = new AccountGmailError("credentials", "boom", new Error("root"));
    expect(err).toBeInstanceOf(Error);
    expect(err.stage).toBe("credentials");
    expect((err.cause as Error).message).toBe("root");
  });
});
