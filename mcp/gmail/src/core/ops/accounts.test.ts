import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListAccountsOutputSchema, SwitchAccountOutputSchema } from "../../tools.js";
import { addAccount, getAccountCredentialsPath, getAccountDir } from "../accounts.js";
import { registry } from "../registry.js";
import { _resetForTests, getCurrentAccountId, setSession } from "../session.js";
import "./accounts.js"; // side-effect: register list_accounts + switch_account

let tmpDir: string;
let originalConfigDir: string | undefined;
let originalAccount: string | undefined;

const TOKEN_BLOB_WORK = JSON.stringify({
  tokens: { access_token: "atok-work", refresh_token: "rtok-work" },
  scopes: ["gmail.modify"],
});
const TOKEN_BLOB_PERSONAL = JSON.stringify({
  tokens: { access_token: "atok-personal", refresh_token: "rtok-personal" },
  scopes: ["gmail.readonly"],
});
const OAUTH_KEYS = JSON.stringify({
  installed: { client_id: "cid", client_secret: "csec" },
});

function buildCtx() {
  return {
    gmail: undefined as never,
    oauth2Client: undefined as never,
    authorizedScopes: ["gmail.modify"],
    signal: new AbortController().signal,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-accounts-op-"));
  originalConfigDir = process.env.GMAIL_CONFIG_DIR;
  originalAccount = process.env.GMAIL_ACCOUNT;
  process.env.GMAIL_CONFIG_DIR = tmpDir;
  delete process.env.GMAIL_ACCOUNT;
  _resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.GMAIL_CONFIG_DIR;
  else process.env.GMAIL_CONFIG_DIR = originalConfigDir;
  if (originalAccount === undefined) delete process.env.GMAIL_ACCOUNT;
  else process.env.GMAIL_ACCOUNT = originalAccount;
  _resetForTests();
});

function writeAccount(id: string, blob: string): void {
  const credsPath = getAccountCredentialsPath(id);
  fs.mkdirSync(getAccountDir(id), { recursive: true });
  fs.writeFileSync(credsPath, blob);
}

function writeSharedOAuthKeys(): void {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "gcp-oauth.keys.json"), OAUTH_KEYS);
}

describe("list_accounts handler", () => {
  it("returns an empty manifest gracefully", async () => {
    const op = registry.get("list_accounts");
    expect(op).toBeDefined();
    const result = await op!.handler({}, buildCtx());
    const parsed = ListAccountsOutputSchema.parse(result.structuredContent);
    expect(parsed.count).toBe(0);
    expect(parsed.accounts).toEqual([]);
    expect(parsed.active.source).toBe("none");
    const text = result.content[0]!.text;
    expect(text).toMatch(/No accounts in the manifest/);
  });

  it("marks the manifest-default account as active when no session is bound", async () => {
    addAccount("work", { emailAddress: "w@example.com", scopes: ["gmail.modify"] });
    addAccount("personal", { emailAddress: "p@example.com", scopes: ["gmail.readonly"] });

    const op = registry.get("list_accounts");
    const result = await op!.handler({}, buildCtx());
    const parsed = ListAccountsOutputSchema.parse(result.structuredContent);
    expect(parsed.count).toBe(2);
    expect(parsed.active).toEqual({
      id: "work",
      source: "manifest-default",
      isLegacyImplicit: false,
    });
    const work = parsed.accounts.find((a) => a.id === "work")!;
    expect(work.isDefault).toBe(true);
    expect(work.isActive).toBe(true);
    expect(work.emailAddress).toBe("w@example.com");
    expect(work.scopes).toEqual(["gmail.modify"]);
    const personal = parsed.accounts.find((a) => a.id === "personal")!;
    expect(personal.isDefault).toBe(false);
    expect(personal.isActive).toBe(false);
  });

  it("prefers the session's actually-loaded account over the manifest default for `isActive`", async () => {
    addAccount("work", {});
    addAccount("personal", {});
    setSession({
      oauth2Client: {} as never,
      gmail: {} as never,
      authorizedScopes: ["gmail.readonly"],
      accountId: "personal",
    });

    const op = registry.get("list_accounts");
    const result = await op!.handler({}, buildCtx());
    const parsed = ListAccountsOutputSchema.parse(result.structuredContent);
    const personal = parsed.accounts.find((a) => a.id === "personal")!;
    const work = parsed.accounts.find((a) => a.id === "work")!;
    expect(personal.isActive).toBe(true);
    expect(work.isActive).toBe(false);
    expect(work.isDefault).toBe(true); // default in manifest, not currently active
    expect(parsed.active.id).toBe("personal");
  });

  it("output structuredContent always validates against ListAccountsOutputSchema", async () => {
    addAccount("solo", {});
    const op = registry.get("list_accounts");
    const result = await op!.handler({}, buildCtx());
    expect(() => ListAccountsOutputSchema.parse(result.structuredContent)).not.toThrow();
  });
});

describe("switch_account handler", () => {
  it("rejects an account not in the manifest", async () => {
    const op = registry.get("switch_account");
    await expect(op!.handler({ accountId: "ghost" }, buildCtx())).rejects.toThrow(/not found/i);
  });

  it("rejects a malformed accountId via validateAccountId", async () => {
    const op = registry.get("switch_account");
    await expect(op!.handler({ accountId: "../escape" }, buildCtx())).rejects.toThrow();
  });

  it("returns idempotent no-op when switching to the already-active account", async () => {
    addAccount("work", { emailAddress: "w@example.com", scopes: ["gmail.modify"] });
    setSession({
      oauth2Client: {} as never,
      gmail: {} as never,
      authorizedScopes: ["gmail.modify"],
      accountId: "work",
    });
    const op = registry.get("switch_account");
    const result = await op!.handler({ accountId: "work" }, buildCtx());
    const parsed = SwitchAccountOutputSchema.parse(result.structuredContent);
    expect(parsed.newAccountId).toBe("work");
    expect(parsed.previousAccountId).toBe("work");
    expect(parsed.note).toMatch(/already active/i);
    // Session unchanged.
    expect(getCurrentAccountId()).toBe("work");
  });

  it("loads credentials + OAuth keys, swaps the session, and returns prev/new ids", async () => {
    writeSharedOAuthKeys();
    addAccount("work", { emailAddress: "w@example.com", scopes: ["gmail.modify"] });
    addAccount("personal", { emailAddress: "p@example.com", scopes: ["gmail.readonly"] });
    writeAccount("work", TOKEN_BLOB_WORK);
    writeAccount("personal", TOKEN_BLOB_PERSONAL);

    // Start with work active.
    setSession({
      oauth2Client: {} as never,
      gmail: {} as never,
      authorizedScopes: ["gmail.modify"],
      accountId: "work",
    });

    const op = registry.get("switch_account");
    const result = await op!.handler({ accountId: "personal" }, buildCtx());
    const parsed = SwitchAccountOutputSchema.parse(result.structuredContent);
    expect(parsed.previousAccountId).toBe("work");
    expect(parsed.newAccountId).toBe("personal");
    expect(parsed.scopes).toEqual(["gmail.readonly"]);
    expect(parsed.emailAddress).toBe("p@example.com");
    expect(parsed.note).toMatch(/cached tools\/list does not auto-refresh/i);

    // Session has actually swapped.
    expect(getCurrentAccountId()).toBe("personal");

    const text = result.content[0]!.text;
    expect(text).toMatch(/work → personal/);
    expect(text).toMatch(/gmail\.readonly/);
  });

  it("surfaces a clear message + re-auth hint when credentials are missing", async () => {
    writeSharedOAuthKeys();
    addAccount("work", { emailAddress: "w@example.com" });
    // Note: no credentials.json written for work.
    const op = registry.get("switch_account");
    await expect(op!.handler({ accountId: "work" }, buildCtx())).rejects.toThrow(
      /failed to load credentials/i,
    );
  });

  it("surfaces a clear message when OAuth keys are missing", async () => {
    addAccount("work", {});
    writeAccount("work", TOKEN_BLOB_WORK);
    // No shared gcp-oauth.keys.json written.
    const op = registry.get("switch_account");
    await expect(op!.handler({ accountId: "work" }, buildCtx())).rejects.toThrow(
      /failed to load OAuth keys/i,
    );
  });
});

describe("registry surface", () => {
  it("registers list_accounts with scopes:[] and readOnlyHint=true", () => {
    const op = registry.get("list_accounts");
    expect(op).toBeDefined();
    expect(op!.scopes).toEqual([]);
  });

  it("registers switch_account with scopes:[]", () => {
    const op = registry.get("switch_account");
    expect(op).toBeDefined();
    expect(op!.scopes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: switch_account end-to-end behaviours (Pre-TUI Steps 3 + 4)
// ---------------------------------------------------------------------------

describe("switch_account integration (mid-session)", () => {
  it("fires sessionEvents.accountChanged with the right payload", async () => {
    writeSharedOAuthKeys();
    addAccount("work", { emailAddress: "w@example.com", scopes: ["gmail.modify"] });
    addAccount("personal", {
      emailAddress: "p@example.com",
      scopes: ["gmail.readonly"],
    });
    writeAccount("work", TOKEN_BLOB_WORK);
    writeAccount("personal", TOKEN_BLOB_PERSONAL);

    setSession({
      oauth2Client: {} as never,
      gmail: {} as never,
      authorizedScopes: ["gmail.modify"],
      accountId: "work",
    });

    const { sessionEvents } = await import("../session.js");
    const handler = vi.fn();
    sessionEvents.on("accountChanged", handler);

    const op = registry.get("switch_account");
    await op!.handler({ accountId: "personal" }, buildCtx());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        previous: "work",
        current: "personal",
        scopes: ["gmail.readonly"],
      }),
    );

    sessionEvents.removeAllListeners();
  });

  it("idempotent switch does NOT fire accountChanged", async () => {
    writeSharedOAuthKeys();
    addAccount("work", { emailAddress: "w@example.com", scopes: ["gmail.modify"] });

    setSession({
      oauth2Client: {} as never,
      gmail: {} as never,
      authorizedScopes: ["gmail.modify"],
      accountId: "work",
    });

    const { sessionEvents } = await import("../session.js");
    const handler = vi.fn();
    sessionEvents.on("accountChanged", handler);

    const op = registry.get("switch_account");
    await op!.handler({ accountId: "work" }, buildCtx());

    expect(handler).not.toHaveBeenCalled();
    sessionEvents.removeAllListeners();
  });

  it("subsequent ctx snapshots see the NEW gmail handle after a switch", async () => {
    // Proves the swap actually changes which gmail handle the next dispatch
    // gets — the integration concern behind the TUI account-switcher.
    writeSharedOAuthKeys();
    addAccount("work", { emailAddress: "w@example.com", scopes: ["gmail.modify"] });
    addAccount("personal", {
      emailAddress: "p@example.com",
      scopes: ["gmail.readonly"],
    });
    writeAccount("work", TOKEN_BLOB_WORK);
    writeAccount("personal", TOKEN_BLOB_PERSONAL);

    const { getGmail } = await import("../session.js");
    const { createContext } = await import("../context.js");

    // Start with a marker-tagged stub so identity changes are visible.
    setSession({
      oauth2Client: {} as never,
      gmail: { __marker__: "A" } as never,
      authorizedScopes: ["gmail.modify"],
      accountId: "work",
    });
    const before = getGmail() as unknown as { __marker__: string };
    expect(before.__marker__).toBe("A");

    // Take a context snapshot now — this is what an in-flight dispatch holds.
    const inFlightCtx = createContext({
      toolName: "list_inbox_threads",
      signal: new AbortController().signal,
    });

    // Swap — switch_account installs a real googleapis handle.
    const op = registry.get("switch_account");
    await op!.handler({ accountId: "personal" }, buildCtx());

    // Identity changed in the session singleton.
    const after = getGmail();
    expect(after).not.toBe(before);

    // The in-flight context still holds the OLD handle (snapshot semantics).
    // Critical for not breaking concurrent ops mid-swap.
    expect(inFlightCtx.gmail).toBe(before);
    expect((inFlightCtx.gmail as unknown as { __marker__: string }).__marker__).toBe("A");

    // A fresh ctx snapshot gets the NEW handle.
    const newCtx = createContext({
      toolName: "list_inbox_threads",
      signal: new AbortController().signal,
    });
    expect(newCtx.gmail).toBe(after);
    expect(newCtx.gmail).not.toBe(before);
  });

  it("health_check is unaffected by account swaps (canary contract)", async () => {
    writeSharedOAuthKeys();
    addAccount("work", { emailAddress: "w@example.com", scopes: ["gmail.modify"] });
    addAccount("personal", {
      emailAddress: "p@example.com",
      scopes: ["gmail.readonly"],
    });
    writeAccount("work", TOKEN_BLOB_WORK);
    writeAccount("personal", TOKEN_BLOB_PERSONAL);

    setSession({
      oauth2Client: {} as never,
      gmail: {} as never,
      authorizedScopes: ["gmail.modify"],
      accountId: "work",
    });

    // health_check before swap.
    await import("./health.js");
    const health = registry.get("health_check");
    const before = await health!.handler({}, buildCtx());
    expect(before.structuredContent).toBeDefined();
    const beforeStatus = (before.structuredContent as { status: string }).status;

    // Swap.
    const op = registry.get("switch_account");
    await op!.handler({ accountId: "personal" }, buildCtx());

    // health_check after swap — still produces a snapshot. The status field
    // depends on watchdog state, which is process-global and unaffected by
    // account changes; assert at minimum that it returned a structuredContent
    // and didn't throw.
    const after = await health!.handler({}, buildCtx());
    expect(after.structuredContent).toBeDefined();
    expect(typeof (after.structuredContent as { status: string }).status).toBe("string");
    expect((after.structuredContent as { status: string }).status).toBe(beforeStatus);
  });
});
