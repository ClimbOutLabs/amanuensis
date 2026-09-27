import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAccountDir, getAccountOAuthPath } from "./accounts.js";
import { loadOAuthKeys } from "./auth-flow.js";

let tmpDir: string;
const env = () => ({ GMAIL_CONFIG_DIR: tmpDir });

const SHARED_KEYS = JSON.stringify({
  installed: { client_id: "shared-id", client_secret: "shared-secret" },
});
const PER_ACCOUNT_KEYS = JSON.stringify({
  installed: { client_id: "work-id", client_secret: "work-secret" },
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-keys-multi-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadOAuthKeys with accountId", () => {
  it("uses per-account file when it exists", () => {
    const sharedPath = path.join(tmpDir, "gcp-oauth.keys.json");
    fs.writeFileSync(sharedPath, SHARED_KEYS);
    fs.mkdirSync(getAccountDir("work", env()), { recursive: true });
    fs.writeFileSync(getAccountOAuthPath("work", env()), PER_ACCOUNT_KEYS);

    const keys = loadOAuthKeys({
      oauthPath: sharedPath,
      env: env(),
      accountId: "work",
    });
    expect(keys.client_id).toBe("work-id");
  });

  it("falls back to shared file when per-account override is absent", () => {
    const sharedPath = path.join(tmpDir, "gcp-oauth.keys.json");
    fs.writeFileSync(sharedPath, SHARED_KEYS);

    const keys = loadOAuthKeys({
      oauthPath: sharedPath,
      env: env(),
      accountId: "work",
    });
    expect(keys.client_id).toBe("shared-id");
  });

  it("env-inline GMAIL_OAUTH_KEYS_JSON still wins over per-account override", () => {
    fs.mkdirSync(getAccountDir("work", env()), { recursive: true });
    fs.writeFileSync(getAccountOAuthPath("work", env()), PER_ACCOUNT_KEYS);

    const keys = loadOAuthKeys({
      oauthPath: "/this/path/does/not/exist",
      env: {
        ...env(),
        GMAIL_OAUTH_KEYS_JSON: JSON.stringify({
          installed: { client_id: "env-id", client_secret: "env-secret" },
        }),
      },
      accountId: "work",
    });
    expect(keys.client_id).toBe("env-id");
  });

  it("legacy behaviour preserved when accountId is not supplied", () => {
    const sharedPath = path.join(tmpDir, "gcp-oauth.keys.json");
    fs.writeFileSync(sharedPath, SHARED_KEYS);

    const keys = loadOAuthKeys({ oauthPath: sharedPath, env: env() });
    expect(keys.client_id).toBe("shared-id");
  });
});
