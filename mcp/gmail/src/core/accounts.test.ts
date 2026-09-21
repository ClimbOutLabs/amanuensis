import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountNotFoundError,
  addAccount,
  getAccountCredentialsPath,
  getAccountDir,
  getAccountOAuthPath,
  getAccountsDir,
  getManifestPath,
  InvalidAccountIdError,
  listAccounts,
  loadManifest,
  removeAccount,
  resolveActiveAccount,
  saveManifest,
  setDefaultAccount,
  validateAccountId,
} from "./accounts.js";

let tmpDir: string;

function makeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { GMAIL_CONFIG_DIR: tmpDir, ...extra };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-accounts-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("validateAccountId", () => {
  it("accepts well-formed ids", () => {
    for (const id of ["default", "work", "personal", "user-1", "a.b.c", "with_under"]) {
      expect(() => validateAccountId(id)).not.toThrow();
    }
  });

  it("rejects empty / non-string / overlong / bad-prefix", () => {
    for (const bad of ["", " ", ".leading", "-leading", "_leading", "a/b", "a b", "a".repeat(65)]) {
      expect(() => validateAccountId(bad)).toThrow(InvalidAccountIdError);
    }
  });
});

describe("path helpers", () => {
  it("getAccountsDir composes configDir/accounts", () => {
    expect(getAccountsDir(makeEnv())).toBe(path.join(tmpDir, "accounts"));
  });

  it("getAccountDir composes configDir/accounts/<id>", () => {
    expect(getAccountDir("work", makeEnv())).toBe(path.join(tmpDir, "accounts", "work"));
  });

  it("getAccountCredentialsPath / getAccountOAuthPath nest correctly", () => {
    expect(getAccountCredentialsPath("work", makeEnv())).toBe(
      path.join(tmpDir, "accounts", "work", "credentials.json"),
    );
    expect(getAccountOAuthPath("work", makeEnv())).toBe(
      path.join(tmpDir, "accounts", "work", "gcp-oauth.keys.json"),
    );
  });

  it("getAccountDir rejects malformed ids", () => {
    expect(() => getAccountDir("../escape", makeEnv())).toThrow(InvalidAccountIdError);
  });

  it("getManifestPath composes configDir/accounts.json", () => {
    expect(getManifestPath(makeEnv())).toBe(path.join(tmpDir, "accounts.json"));
  });
});

describe("loadManifest / saveManifest", () => {
  it("returns null when no manifest file exists", () => {
    expect(loadManifest({ env: makeEnv() })).toBeNull();
  });

  it("round-trips through save + load", () => {
    saveManifest(
      {
        defaultAccount: "work",
        accounts: {
          work: { createdAt: "2026-01-01T00:00:00.000Z", emailAddress: "w@example.com" },
          personal: { createdAt: "2026-02-01T00:00:00.000Z", scopes: ["gmail.modify"] },
        },
      },
      makeEnv(),
    );
    const loaded = loadManifest({ env: makeEnv() });
    expect(loaded).toEqual({
      defaultAccount: "work",
      accounts: {
        work: {
          createdAt: "2026-01-01T00:00:00.000Z",
          emailAddress: "w@example.com",
          scopes: undefined,
        },
        personal: {
          createdAt: "2026-02-01T00:00:00.000Z",
          emailAddress: undefined,
          scopes: ["gmail.modify"],
        },
      },
    });
  });

  it("throws on malformed JSON", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(getManifestPath(makeEnv()), "{not json");
    expect(() => loadManifest({ env: makeEnv() })).toThrow(/Could not parse/);
  });

  it("throws when the parsed value is not an object", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(getManifestPath(makeEnv()), `"a string"`);
    expect(() => loadManifest({ env: makeEnv() })).toThrow(/must contain a JSON object/);
  });

  it("writes file with mode 0600 (POSIX)", () => {
    saveManifest({ defaultAccount: "x", accounts: { x: { createdAt: "t" } } }, makeEnv());
    const mode = fs.statSync(getManifestPath(makeEnv())).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });
});

describe("addAccount / removeAccount / setDefaultAccount", () => {
  it("first add creates manifest and sets default", () => {
    const m = addAccount("work", { emailAddress: "w@example.com" }, makeEnv());
    expect(m.defaultAccount).toBe("work");
    expect(m.accounts.work.emailAddress).toBe("w@example.com");
    expect(loadManifest({ env: makeEnv() })?.defaultAccount).toBe("work");
  });

  it("second add does not steal default", () => {
    addAccount("work", {}, makeEnv());
    const m = addAccount("personal", {}, makeEnv());
    expect(m.defaultAccount).toBe("work");
    expect(Object.keys(m.accounts).sort()).toEqual(["personal", "work"]);
  });

  it("readd of same id preserves createdAt and merges fields", () => {
    addAccount("work", { emailAddress: "old@example.com" }, makeEnv());
    const before = loadManifest({ env: makeEnv() })!.accounts.work.createdAt;
    const m = addAccount("work", { scopes: ["gmail.modify"] }, makeEnv());
    expect(m.accounts.work.createdAt).toBe(before);
    expect(m.accounts.work.emailAddress).toBe("old@example.com");
    expect(m.accounts.work.scopes).toEqual(["gmail.modify"]);
  });

  it("remove drops the entry and re-points default if needed", () => {
    addAccount("work", {}, makeEnv());
    addAccount("personal", {}, makeEnv());
    const m1 = removeAccount("work", makeEnv()); // default was 'work', should re-point
    expect(m1.defaultAccount).toBe("personal");
    expect(m1.accounts.work).toBeUndefined();
  });

  it("remove of unknown id throws AccountNotFoundError", () => {
    addAccount("work", {}, makeEnv());
    expect(() => removeAccount("nope", makeEnv())).toThrow(AccountNotFoundError);
  });

  it("remove when manifest missing throws AccountNotFoundError", () => {
    expect(() => removeAccount("anything", makeEnv())).toThrow(AccountNotFoundError);
  });

  it("setDefaultAccount changes the default", () => {
    addAccount("work", {}, makeEnv());
    addAccount("personal", {}, makeEnv());
    const m = setDefaultAccount("personal", makeEnv());
    expect(m.defaultAccount).toBe("personal");
  });

  it("setDefaultAccount throws when id not in manifest", () => {
    addAccount("work", {}, makeEnv());
    expect(() => setDefaultAccount("nope", makeEnv())).toThrow(AccountNotFoundError);
  });

  it("add rejects malformed id", () => {
    expect(() => addAccount("../bad", {}, makeEnv())).toThrow(InvalidAccountIdError);
  });
});

describe("listAccounts", () => {
  it("returns [] when no manifest", () => {
    expect(listAccounts(makeEnv())).toEqual([]);
  });

  it("sorts and flags the default", () => {
    addAccount("zeta", {}, makeEnv());
    addAccount("alpha", {}, makeEnv());
    const items = listAccounts(makeEnv());
    expect(items.map((i) => i.id)).toEqual(["alpha", "zeta"]);
    expect(items.find((i) => i.id === "zeta")?.isDefault).toBe(true);
    expect(items.find((i) => i.id === "alpha")?.isDefault).toBe(false);
  });
});

describe("resolveActiveAccount precedence chain", () => {
  it("--account flag wins over everything", () => {
    addAccount("work", {}, makeEnv());
    const r = resolveActiveAccount({
      env: makeEnv({ GMAIL_ACCOUNT: "personal" }),
      flagAccount: "explicit",
    });
    expect(r).toEqual({ id: "explicit", source: "flag", isLegacyImplicit: false });
  });

  it("GMAIL_ACCOUNT env wins over manifest default", () => {
    addAccount("work", {}, makeEnv());
    const r = resolveActiveAccount({ env: makeEnv({ GMAIL_ACCOUNT: "personal" }) });
    expect(r).toEqual({ id: "personal", source: "env", isLegacyImplicit: false });
  });

  it("manifest default used when only manifest is configured", () => {
    addAccount("work", {}, makeEnv());
    addAccount("personal", {}, makeEnv());
    const r = resolveActiveAccount({ env: makeEnv() });
    expect(r).toEqual({ id: "work", source: "manifest-default", isLegacyImplicit: false });
  });

  it("sole-account branch when manifest has one account but no default", () => {
    saveManifest({ defaultAccount: "", accounts: { lonely: { createdAt: "t" } } }, makeEnv());
    const r = resolveActiveAccount({ env: makeEnv() });
    expect(r).toEqual({ id: "lonely", source: "manifest-sole", isLegacyImplicit: false });
  });

  it("returns none when manifest has multiple accounts but no resolvable default", () => {
    saveManifest(
      { defaultAccount: "", accounts: { a: { createdAt: "t" }, b: { createdAt: "t" } } },
      makeEnv(),
    );
    const r = resolveActiveAccount({ env: makeEnv() });
    expect(r.id).toBeNull();
    expect(r.source).toBe("none");
  });

  it("legacy-implicit when no manifest but legacy credentials.json exists", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "credentials.json"), "{}");
    const r = resolveActiveAccount({ env: makeEnv() });
    expect(r).toEqual({ id: "default", source: "legacy-implicit", isLegacyImplicit: true });
  });

  it("legacy-implicit suppressed when env-driven credentials are configured", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "credentials.json"), "{}");
    const r = resolveActiveAccount({
      env: makeEnv({ GMAIL_CREDENTIALS_JSON: '{"tokens":{}}' }),
    });
    expect(r.source).toBe("none");
    expect(r.isLegacyImplicit).toBe(false);
  });

  it("returns none when neither manifest nor legacy file exist", () => {
    const r = resolveActiveAccount({ env: makeEnv() });
    expect(r).toEqual({ id: null, source: "none", isLegacyImplicit: false });
  });

  it("rejects malformed flag", () => {
    expect(() => resolveActiveAccount({ env: makeEnv(), flagAccount: "../bad" })).toThrow(
      InvalidAccountIdError,
    );
  });
});
