import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAccountCredentialsPath, loadManifest } from "./accounts.js";
import { loadCredentials } from "./credentials.js";

let tmpDir: string;
const env = () => ({ GMAIL_CONFIG_DIR: tmpDir });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-creds-multi-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const CRED_BLOB = JSON.stringify({
  tokens: { access_token: "atok", refresh_token: "rtok" },
  scopes: ["gmail.modify"],
});

describe("loadCredentials with accountId", () => {
  it("reads the per-account credentials file when present", async () => {
    const target = getAccountCredentialsPath("work", env());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, CRED_BLOB);

    const result = await loadCredentials({ env: env(), accountId: "work" });
    expect(result.source).toBe("file");
    expect(result.locator).toBe(target);
    expect(result.credentials.tokens.access_token).toBe("atok");
    expect(result.credentials.scopes).toEqual(["gmail.modify"]);
  });

  it("env JSON still wins even when accountId is supplied (single-account env mode)", async () => {
    const result = await loadCredentials({
      env: { ...env(), GMAIL_CREDENTIALS_JSON: CRED_BLOB },
      accountId: "work",
    });
    expect(result.source).toBe("env-json");
  });

  it("errors with the per-account path in the message when the file is missing", async () => {
    await expect(loadCredentials({ env: env(), accountId: "ghost" })).rejects.toThrow(
      /accounts\/ghost\/credentials\.json/,
    );
  });
});

describe("M1 migration shim", () => {
  it("promotes legacy credentials.json into accounts/default/ on first read for accountId=default", async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const legacyPath = path.join(tmpDir, "credentials.json");
    fs.writeFileSync(legacyPath, CRED_BLOB);

    const result = await loadCredentials({ env: env(), accountId: "default" });

    // Per-account file now exists.
    const newPath = getAccountCredentialsPath("default", env());
    expect(fs.existsSync(newPath)).toBe(true);
    // Legacy file untouched (copy, not move).
    expect(fs.existsSync(legacyPath)).toBe(true);
    // Loader read from the new path.
    expect(result.locator).toBe(newPath);
    expect(result.credentials.tokens.access_token).toBe("atok");

    // Manifest was stamped with the default account.
    const manifest = loadManifest({ env: env() });
    expect(manifest).not.toBeNull();
    expect(manifest!.defaultAccount).toBe("default");
    expect(manifest!.accounts.default).toBeDefined();
  });

  it("does NOT migrate for non-default account ids", async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "credentials.json"), CRED_BLOB);

    await expect(loadCredentials({ env: env(), accountId: "work" })).rejects.toThrow(/not found/);
    // No accounts/work directory should have been created.
    expect(fs.existsSync(path.join(tmpDir, "accounts", "work"))).toBe(false);
  });

  it("is idempotent — second read sees the migrated file without re-copying", async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "credentials.json"), CRED_BLOB);
    await loadCredentials({ env: env(), accountId: "default" });

    // Mutate the new file to prove subsequent reads don't overwrite.
    const newPath = getAccountCredentialsPath("default", env());
    fs.writeFileSync(
      newPath,
      JSON.stringify({ tokens: { access_token: "after-mutation" }, scopes: [] }),
    );

    const result = await loadCredentials({ env: env(), accountId: "default" });
    expect(result.credentials.tokens.access_token).toBe("after-mutation");
  });

  it("legacy single-account behaviour preserved when accountId is not passed", async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "credentials.json"), CRED_BLOB);

    const result = await loadCredentials({ env: env() });
    expect(result.source).toBe("file");
    expect(result.locator).toBe(path.join(tmpDir, "credentials.json"));
    // No migration triggered.
    expect(fs.existsSync(path.join(tmpDir, "accounts"))).toBe(false);
    expect(loadManifest({ env: env() })).toBeNull();
  });
});
