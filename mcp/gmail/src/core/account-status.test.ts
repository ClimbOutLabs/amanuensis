import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkAllAccountAuthStatusesLive,
  checkAndCacheAccountAuthStatusLive,
} from "./account-status.js";
import { addAccount, getAccountCredentialsPath, loadManifest } from "./accounts.js";

let tmpDir: string;

function makeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { GMAIL_CONFIG_DIR: tmpDir, ...extra };
}

function writeCredentials(id: string, scopes: string[] = ["gmail.modify"]): void {
  const credentialsPath = getAccountCredentialsPath(id, makeEnv());
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(
    credentialsPath,
    JSON.stringify({
      tokens: {
        access_token: `${id}-access`,
        refresh_token: `${id}-refresh`,
        expiry_date: Date.now() + 60_000,
      },
      scopes,
    }),
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-account-status-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("live account auth checks", () => {
  it("verifies token material and caches the Gmail email address in the manifest", async () => {
    addAccount("work", { scopes: ["gmail.modify"] }, makeEnv());
    writeCredentials("work");

    const status = await checkAndCacheAccountAuthStatusLive("work", {
      env: makeEnv(),
      verifier: async ({ id }) => ({ emailAddress: `${id}@example.test` }),
    });

    expect(status).toEqual(
      expect.objectContaining({
        id: "work",
        status: "ok",
        emailAddress: "work@example.test",
      }),
    );
    const entry = loadManifest({ env: makeEnv() })?.accounts.work;
    expect(entry).toEqual(
      expect.objectContaining({
        authStatus: "ok",
        authError: undefined,
        emailAddress: "work@example.test",
        scopes: ["gmail.modify"],
        lastCheckedAt: status.checkedAt,
      }),
    );
  });

  it("marks invalid_grant as needs_reauth and caches the remediation status", async () => {
    addAccount("work", { emailAddress: "old@example.test" }, makeEnv());
    writeCredentials("work");

    const status = await checkAndCacheAccountAuthStatusLive("work", {
      env: makeEnv(),
      verifier: async () => {
        throw new Error("invalid_grant");
      },
    });

    expect(status.status).toBe("needs_reauth");
    expect(status.emailAddress).toBe("old@example.test");
    expect(status.message).toMatch(/invalid_grant/);
    const entry = loadManifest({ env: makeEnv() })?.accounts.work;
    expect(entry?.authStatus).toBe("needs_reauth");
    expect(entry?.authError).toMatch(/invalid_grant/);
    expect(entry?.emailAddress).toBe("old@example.test");
  });

  it("treats 401 verifier errors as re-auth failures even when the message is generic", async () => {
    addAccount("work", {}, makeEnv());
    writeCredentials("work");

    const status = await checkAndCacheAccountAuthStatusLive("work", {
      env: makeEnv(),
      verifier: async () => {
        throw Object.assign(new Error("Request failed"), { code: 401 });
      },
    });

    expect(status.status).toBe("needs_reauth");
    expect(status.message).toMatch(/Request failed/);
  });

  it("does not call the live verifier when local credentials are missing", async () => {
    addAccount("work", {}, makeEnv());
    let calls = 0;

    const status = await checkAndCacheAccountAuthStatusLive("work", {
      env: makeEnv(),
      verifier: async () => {
        calls += 1;
        return { emailAddress: "work@example.test" };
      },
    });

    expect(status.status).toBe("missing_credentials");
    expect(calls).toBe(0);
  });

  it("checks all accounts and updates each cached status", async () => {
    addAccount("work", {}, makeEnv());
    addAccount("personal", {}, makeEnv());
    writeCredentials("work");
    writeCredentials("personal", ["gmail.readonly"]);

    const statuses = await checkAllAccountAuthStatusesLive({
      env: makeEnv(),
      verifier: async ({ id }) => ({ emailAddress: `${id}@example.test` }),
    });

    expect(statuses.map((s) => [s.id, s.status, s.emailAddress])).toEqual([
      ["personal", "ok", "personal@example.test"],
      ["work", "ok", "work@example.test"],
    ]);
    const manifest = loadManifest({ env: makeEnv() });
    expect(manifest?.accounts.work.emailAddress).toBe("work@example.test");
    expect(manifest?.accounts.personal.emailAddress).toBe("personal@example.test");
  });
});
