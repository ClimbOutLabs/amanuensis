// Handler-level tests for unread_summary (Milestone C). Runs in fixture mode
// against the committed corpus so the per-account handles are the JSON fake
// client — no network. Covers aggregation, the active-account marker, the
// no-read-scope skip, per-account error capture, and the empty-manifest path.
// The full bootstrap→dispatch aggregation lives in tests/e2e/unread-summary.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnreadSummaryOutputSchema } from "../../tools.js";
import { addAccount } from "../accounts.js";
import { registry } from "../registry.js";
import { _resetForTests, getCurrentAccountId, setSession } from "../session.js";
import "./accounts.js"; // side-effect: registers unread_summary

const FIXTURE_DIR = fileURLToPath(new URL("../../../fixtures/gmail", import.meta.url));
const ENV_KEYS = ["GMAIL_CONFIG_DIR", "GMAIL_ACCOUNT", "GMAIL_FIXTURE_MODE", "GMAIL_FIXTURE_DIR"];

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

function ctx() {
  return {
    gmail: undefined as never,
    oauth2Client: undefined as never,
    authorizedScopes: ["gmail.modify"],
    signal: new AbortController().signal,
  };
}

async function run() {
  const op = registry.get("unread_summary");
  expect(op).toBeDefined();
  const result = await op!.handler({}, ctx());
  return UnreadSummaryOutputSchema.parse(result.structuredContent);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-unread-unit-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.GMAIL_CONFIG_DIR = tmpDir;
  process.env.GMAIL_FIXTURE_MODE = "1";
  process.env.GMAIL_FIXTURE_DIR = FIXTURE_DIR;
  delete process.env.GMAIL_ACCOUNT;
  _resetForTests();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetForTests();
});

describe("unread_summary handler", () => {
  it("aggregates unread counts, marks the active account, and does not touch the session", async () => {
    addAccount("work", { emailAddress: "user-work@fixture.test", scopes: ["gmail.modify"] });
    addAccount("personal", {
      emailAddress: "user-personal@fixture.test",
      scopes: ["gmail.readonly"],
    });
    setSession({
      oauth2Client: {} as never,
      gmail: {} as never,
      authorizedScopes: ["gmail.modify"],
      accountId: "work",
    });

    const parsed = await run();
    expect(parsed.activeAccountId).toBe("work");
    expect(parsed.accounts.find((a) => a.id === "work")).toMatchObject({
      unreadInbox: 3,
      unreadTotal: 5,
    });
    expect(parsed.accounts.find((a) => a.id === "personal")).toMatchObject({
      unreadInbox: 1,
      unreadTotal: 2,
    });
    expect(parsed.totalUnread).toBe(4);
    expect(parsed.truncated).toBe(false);
    expect(parsed.total_available).toBe(parsed.accounts.length);
    // The summary must never swap the active account.
    expect(getCurrentAccountId()).toBe("work");
  });

  it("skips accounts whose stored scopes lack a read scope", async () => {
    addAccount("work", { scopes: ["gmail.modify"] });
    addAccount("sendonly", { emailAddress: "s@fixture.test", scopes: ["gmail.send"] });

    const parsed = await run();
    const sendonly = parsed.accounts.find((a) => a.id === "sendonly");
    expect(sendonly?.skippedReason).toMatch(/no read scope/i);
    expect(sendonly?.unreadInbox).toBeNull();
    expect(sendonly?.error).toBeUndefined();
    // A skipped account contributes 0 to the aggregate (work inbox = 3).
    expect(parsed.totalUnread).toBe(3);
  });

  it("captures a per-account error when the account cannot be read", async () => {
    addAccount("ghost", { emailAddress: "g@fixture.test", scopes: ["gmail.readonly"] });

    const parsed = await run();
    const ghost = parsed.accounts.find((a) => a.id === "ghost");
    expect(ghost?.error).toBeTruthy();
    expect(ghost?.unreadInbox).toBeNull();
    expect(ghost?.unreadTotal).toBeNull();
    expect(ghost?.skippedReason).toBeUndefined();
  });

  it("returns an empty, well-formed summary when no accounts are configured", async () => {
    const parsed = await run();
    expect(parsed.accounts).toEqual([]);
    expect(parsed.totalUnread).toBe(0);
    expect(parsed.truncated).toBe(false);
    expect(parsed.total_available).toBe(0);
  });
});
