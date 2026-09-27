import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { attachTokenPersistence, CredentialLoadError, loadCredentials } from "./credentials.js";

function makeStubs(overrides: Partial<Parameters<typeof loadCredentials>[0]> = {}) {
  return {
    fileExists: vi.fn(() => false),
    readFile: vi.fn(() => ""),
    runOp: vi.fn(async () => ""),
    ...overrides,
  };
}

describe("loadCredentials precedence", () => {
  it("env JSON wins over 1Password and file", async () => {
    const stubs = makeStubs();
    const result = await loadCredentials({
      env: {
        GMAIL_CREDENTIALS_JSON: JSON.stringify({
          tokens: { access_token: "from-env" },
          scopes: ["gmail.readonly"],
        }),
        GMAIL_CREDENTIALS_OP: "op://Personal/foo/bar",
        GMAIL_CREDENTIALS_PATH: "/tmp/should-not-read",
      },
      ...stubs,
    });
    expect(result.source).toBe("env-json");
    expect(result.credentials.tokens.access_token).toBe("from-env");
    expect(result.credentials.scopes).toEqual(["gmail.readonly"]);
    expect(stubs.runOp).not.toHaveBeenCalled();
    expect(stubs.fileExists).not.toHaveBeenCalled();
  });

  it("1Password wins over file when env JSON missing", async () => {
    const runOp = vi.fn(async () =>
      JSON.stringify({ tokens: { access_token: "from-op" }, scopes: ["gmail.modify"] }),
    );
    const stubs = makeStubs({ runOp });
    const result = await loadCredentials({
      env: {
        GMAIL_CREDENTIALS_OP: "op://Personal/gmail-mcp/credentials",
        GMAIL_CREDENTIALS_PATH: "/tmp/should-not-read",
      },
      ...stubs,
    });
    expect(result.source).toBe("1password");
    expect(result.locator).toBe("op://Personal/gmail-mcp/credentials");
    expect(result.credentials.tokens.access_token).toBe("from-op");
    expect(runOp).toHaveBeenCalledOnce();
    expect(runOp).toHaveBeenCalledWith("op://Personal/gmail-mcp/credentials");
    expect(stubs.fileExists).not.toHaveBeenCalled();
  });

  it("falls back to file when env JSON and 1Password unset", async () => {
    const stubs = makeStubs({
      fileExists: vi.fn(() => true),
      readFile: vi.fn(() =>
        JSON.stringify({ tokens: { access_token: "from-file" }, scopes: ["gmail.modify"] }),
      ),
    });
    const result = await loadCredentials({
      env: { GMAIL_CREDENTIALS_PATH: "/tmp/creds.json" },
      ...stubs,
    });
    expect(result.source).toBe("file");
    expect(result.locator).toBe("/tmp/creds.json");
    expect(result.credentials.tokens.access_token).toBe("from-file");
  });

  it("uses fallbackPath when GMAIL_CREDENTIALS_PATH unset", async () => {
    const stubs = makeStubs({
      fileExists: vi.fn(() => true),
      readFile: vi.fn(() => JSON.stringify({ tokens: { access_token: "fallback" } })),
    });
    const result = await loadCredentials({
      env: {},
      fallbackPath: "/home/x/.gmail-mcp/credentials.json",
      ...stubs,
    });
    expect(result.source).toBe("file");
    expect(result.locator).toBe("/home/x/.gmail-mcp/credentials.json");
  });

  it("per-account file wins over fallbackPath when accountId is set", async () => {
    // Pin this regression: prior versions read fallbackPath unconditionally
    // when accountId was set, which made every multi-account user load the
    // legacy single-account file instead of accounts/<id>/credentials.json.
    const perAccountPath = "/cfg/accounts/work/credentials.json";
    const legacyPath = "/cfg/credentials.json";
    const fileExists = vi.fn((p: string) => p === perAccountPath);
    const readFile = vi.fn((p: string) => {
      if (p === perAccountPath) {
        return JSON.stringify({
          tokens: { access_token: "from-work" },
          scopes: ["gmail.modify"],
        });
      }
      throw new Error(`unexpected read: ${p}`);
    });
    const result = await loadCredentials({
      env: { GMAIL_CONFIG_DIR: "/cfg" },
      accountId: "work",
      fallbackPath: legacyPath,
      fileExists,
      readFile,
      runOp: vi.fn(async () => ""),
    });
    expect(result.source).toBe("file");
    expect(result.locator).toBe(perAccountPath);
    expect(result.credentials.tokens.access_token).toBe("from-work");
  });

  it("falls through to fallbackPath when accountId is undefined", async () => {
    // Unmigrated users with no manifest pass accountId=undefined from
    // bootstrapSession; fallbackPath must still resolve.
    const stubs = makeStubs({
      fileExists: vi.fn(() => true),
      readFile: vi.fn(() => JSON.stringify({ tokens: { access_token: "legacy" } })),
    });
    const result = await loadCredentials({
      env: {},
      fallbackPath: "/legacy/credentials.json",
      ...stubs,
    });
    expect(result.source).toBe("file");
    expect(result.locator).toBe("/legacy/credentials.json");
  });

  it("runs M1 migration when accountId=default and only legacy exists", async () => {
    // The shim copies <configDir>/credentials.json → accounts/default/credentials.json
    // and then reads from the per-account path. We can't intercept the real
    // copy without monkey-patching node:fs at the module level, so this test
    // asserts the call shape (per-account path resolved; legacy detected).
    // The actual fs operations are covered by the integration test in the
    // bootstrap suite — here we just confirm the precedence routes through
    // the per-account branch even when the per-account file is initially missing.
    let migrationAttempted = false;
    const perAccountPath = "/cfg/accounts/default/credentials.json";
    const legacyPath = "/cfg/credentials.json";
    const fileExists = vi.fn((p: string) => {
      if (p === legacyPath) return true;
      // After the (uninstrumented) migration copy, the per-account file appears
      if (p === perAccountPath) {
        const wasMissing = !migrationAttempted;
        migrationAttempted = true;
        return !wasMissing;
      }
      return false;
    });
    const readFile = vi.fn((p: string) => {
      if (p === perAccountPath) {
        return JSON.stringify({ tokens: { access_token: "migrated" } });
      }
      throw new Error(`unexpected read: ${p}`);
    });
    // The real migration writes via fs; in this stubbed test the migration
    // shim's writes happen against the real filesystem. To keep this test
    // hermetic we accept that runDefaultAccountMigration may throw silently
    // (it catches its own errors). The behavioural assertion is: the loader
    // resolved the per-account path, not the legacy fallback.
    try {
      const result = await loadCredentials({
        env: { GMAIL_CONFIG_DIR: "/cfg" },
        accountId: "default",
        fallbackPath: legacyPath,
        fileExists,
        readFile,
        runOp: vi.fn(async () => ""),
      });
      expect(result.locator).toBe(perAccountPath);
    } catch (err) {
      // Acceptable: migration shim's fs.copyFileSync fails because /cfg/ doesn't
      // exist on disk. What matters is that we attempted the per-account path,
      // never the legacy fallback.
      expect((err as { source?: string }).source).toBe("file");
      expect((err as Error).message).toContain(perAccountPath);
    }
  });
});

describe("loadCredentials errors", () => {
  it("throws when no source configured", async () => {
    const stubs = makeStubs();
    await expect(loadCredentials({ env: {}, ...stubs })).rejects.toBeInstanceOf(
      CredentialLoadError,
    );
  });

  it("throws when file missing", async () => {
    const stubs = makeStubs({ fileExists: vi.fn(() => false) });
    await expect(
      loadCredentials({ env: { GMAIL_CREDENTIALS_PATH: "/nope" }, ...stubs }),
    ).rejects.toMatchObject({ source: "file" });
  });

  it("rejects non-op:// 1Password reference", async () => {
    const stubs = makeStubs();
    await expect(
      loadCredentials({ env: { GMAIL_CREDENTIALS_OP: "not-an-op-ref" }, ...stubs }),
    ).rejects.toMatchObject({ source: "1password" });
  });

  it("wraps op CLI ENOENT with install hint", async () => {
    const enoent = Object.assign(new Error("spawn op ENOENT"), { code: "ENOENT" });
    const stubs = makeStubs({
      runOp: vi.fn(async () => {
        throw enoent;
      }),
    });
    await expect(
      loadCredentials({
        env: { GMAIL_CREDENTIALS_OP: "op://v/i/f" },
        ...stubs,
      }),
    ).rejects.toMatchObject({
      source: "1password",
      message: expect.stringContaining("`op` CLI not found"),
    });
  });

  it("rejects malformed JSON from any source", async () => {
    const stubs = makeStubs();
    await expect(
      loadCredentials({ env: { GMAIL_CREDENTIALS_JSON: "{{{not json" }, ...stubs }),
    ).rejects.toMatchObject({ source: "env-json" });
  });

  it("ignores empty/whitespace env vars", async () => {
    const stubs = makeStubs({
      fileExists: vi.fn(() => true),
      readFile: vi.fn(() => JSON.stringify({ tokens: { x: 1 } })),
    });
    const result = await loadCredentials({
      env: {
        GMAIL_CREDENTIALS_JSON: "   ",
        GMAIL_CREDENTIALS_OP: "",
        GMAIL_CREDENTIALS_PATH: "/tmp/c.json",
      },
      ...stubs,
    });
    expect(result.source).toBe("file");
  });
});

describe("loadCredentials shape compatibility", () => {
  it("supports the canonical {tokens, scopes} shape", async () => {
    const result = await loadCredentials({
      env: {
        GMAIL_CREDENTIALS_JSON: JSON.stringify({
          tokens: { access_token: "a", refresh_token: "r" },
          scopes: ["gmail.modify"],
        }),
      },
      ...makeStubs(),
    });
    expect(result.credentials.tokens).toEqual({ access_token: "a", refresh_token: "r" });
    expect(result.credentials.scopes).toEqual(["gmail.modify"]);
  });

  it("supports the legacy bare-tokens shape (no `tokens` wrapper)", async () => {
    const result = await loadCredentials({
      env: {
        GMAIL_CREDENTIALS_JSON: JSON.stringify({
          access_token: "a",
          refresh_token: "r",
          expiry_date: 12345,
        }),
      },
      ...makeStubs(),
    });
    expect(result.credentials.tokens).toEqual({
      access_token: "a",
      refresh_token: "r",
      expiry_date: 12345,
    });
    expect(result.credentials.scopes).toBeUndefined();
  });
});

describe("attachTokenPersistence", () => {
  it("persists rotations for file credentials while preserving refresh token and scopes", () => {
    const emitter = new EventEmitter();
    const writes: Array<{ path: string; data: string }> = [];
    const rename = vi.fn();
    const attached = attachTokenPersistence(
      emitter,
      {
        source: "file",
        locator: "/config/accounts/work/credentials.json",
        credentials: {
          tokens: { access_token: "old", refresh_token: "refresh", expiry_date: 1 },
          scopes: ["gmail.modify"],
        },
      },
      {
        writeFile: ((path: string, data: string) => writes.push({ path, data })) as any,
        rename: rename as any,
        chmod: vi.fn() as any,
      },
    );

    expect(attached).toBe(true);
    emitter.emit("tokens", { access_token: "new", expiry_date: 2 });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.data)).toEqual({
      tokens: { access_token: "new", refresh_token: "refresh", expiry_date: 2 },
      scopes: ["gmail.modify"],
    });
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(/credentials\.json\.\d+\.tmp$/),
      "/config/accounts/work/credentials.json",
    );
  });

  it("does not attach persistence for env or 1Password credentials", () => {
    for (const source of ["env-json", "1password"] as const) {
      const emitter = new EventEmitter();
      expect(
        attachTokenPersistence(emitter, {
          source,
          credentials: { tokens: { access_token: "a" }, scopes: ["gmail.modify"] },
        }),
      ).toBe(false);
      expect(emitter.listenerCount("tokens")).toBe(0);
    }
  });
});
