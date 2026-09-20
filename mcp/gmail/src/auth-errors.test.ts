import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetForTests,
  isAuthError,
  isNotFoundError,
  tryRefreshForAuthError,
  wrapToolError,
} from "./auth-errors.js";
import type { OAuth2Client } from "google-auth-library";
import { setSession } from "./core/session.js";

describe("isAuthError", () => {
  it.each([
    new Error("invalid_grant"),
    new Error("Error: Invalid Credentials"),
    new Error("invalid grant: token expired"),
    Object.assign(new Error("permission denied"), { code: 403 }),
    Object.assign(new Error("unauthorized"), { status: 401 }),
  ])("classifies %s as auth error", (err) => {
    expect(isAuthError(err)).toBe(true);
  });

  it("returns false for non-auth errors", () => {
    expect(isAuthError(new Error("network unreachable"))).toBe(false);
    expect(isAuthError(new Error("rate limit"))).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError("string error")).toBe(false);
  });
});

describe("wrapToolError", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("includes tool name and message for non-auth errors", async () => {
    const res = await wrapToolError(new Error("kaboom"), "search_emails", null);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("search_emails failed");
    expect(res.content[0].text).toContain("kaboom");
    expect(res.content[0].text).not.toContain("re-authenticate");
  });

  it("includes remediation hint for auth errors", async () => {
    const res = await wrapToolError(
      new Error("Error: Invalid Credentials"),
      "list_email_labels",
      null,
    );
    expect(res.content[0].text).toContain("list_email_labels failed");
    expect(res.content[0].text).toContain("re-authenticate");
    expect(res.content[0].text).toContain("gmail account auth");
  });

  // Refresh orchestration lives in the dispatcher (server/build.ts) via
  // tryRefreshForAuthError — wrapToolError only formats. The per-account
  // cooldown means one invalid_grant storm triggers a single refresh.
  it("attempts refresh on invalid_grant once per cooldown window", async () => {
    const getAccessToken = vi.fn().mockResolvedValue({ token: "new-access-token" });
    const client = { getAccessToken } as unknown as OAuth2Client;

    expect(await tryRefreshForAuthError(new Error("invalid_grant"), client)).toBe(true);
    expect(getAccessToken).toHaveBeenCalledTimes(1);

    // Second invalid_grant within the cooldown — no second attempt.
    expect(await tryRefreshForAuthError(new Error("invalid_grant"), client)).toBe(false);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("returns false (no refresh) for non-invalid_grant auth errors", async () => {
    const getAccessToken = vi.fn();
    const client = { getAccessToken } as unknown as OAuth2Client;
    expect(await tryRefreshForAuthError(new Error("invalid credentials"), client)).toBe(false);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("falls back to re-auth hint when refresh fails", async () => {
    const getAccessToken = vi.fn().mockRejectedValue(new Error("invalid_grant"));
    const client = { getAccessToken } as unknown as Parameters<typeof wrapToolError>[2];

    const res = await wrapToolError(new Error("invalid_grant"), "send_email", client);
    expect(res.content[0].text).toContain("re-authenticate");
    expect(res.content[0].text).toContain("gmail account auth");
  });

  it("handles non-Error inputs", async () => {
    const res = await wrapToolError("string error", "unknown_tool", null);
    expect(res.content[0].text).toContain("unknown_tool failed");
    expect(res.content[0].text).toContain("string error");
  });
});

describe("isNotFoundError", () => {
  it("detects err.code === 404", () => {
    expect(isNotFoundError(Object.assign(new Error("Not Found"), { code: 404 }))).toBe(true);
  });
  it("detects err.status === 404", () => {
    expect(isNotFoundError(Object.assign(new Error("…"), { status: 404 }))).toBe(true);
  });
  it("detects errors[].reason === notFound", () => {
    expect(
      isNotFoundError(Object.assign(new Error("…"), { errors: [{ reason: "notFound" }] })),
    ).toBe(true);
  });
  it("detects bare 'Not Found' message", () => {
    expect(isNotFoundError(new Error("Not Found"))).toBe(true);
  });
  it("ignores non-404s", () => {
    expect(isNotFoundError(new Error("rate limit"))).toBe(false);
    expect(isNotFoundError(Object.assign(new Error("…"), { code: 500 }))).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
  });
});

describe("wrapToolError 404 with account context", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("rewraps a 404 with the active account id and switch hint", async () => {
    setSession({ accountId: "work" });
    const res = await wrapToolError(
      Object.assign(new Error("Not Found"), { code: 404 }),
      "reply_all",
      null,
    );
    const text = res.content[0].text;
    expect(text).toContain("reply_all failed");
    expect(text).toContain('no such message/thread in account "work"');
    expect(text).toContain("sw <id>");
    expect(text).not.toContain("re-authenticate");
    // Non-thread ops shouldn't suggest the messageId-vs-threadId mix-up.
    expect(text).not.toContain("threadId, not a messageId");
  });

  it("adds messageId-vs-threadId hint when the failing op targets a thread", async () => {
    setSession({ accountId: "work" });
    for (const tool of ["get_thread", "modify_thread"]) {
      const res = await wrapToolError(
        Object.assign(new Error("Not Found"), { code: 404 }),
        tool,
        null,
      );
      const text = res.content[0].text;
      expect(text).toContain(`${tool} failed`);
      expect(text).toContain("threadId, not a messageId");
      expect(text).toContain("`read <id>`");
      // Switch-account fallback still mentioned for the wrong-mailbox case.
      expect(text).toContain("sw <id>");
    }
  });

  it("uses generic phrasing when no account is active", async () => {
    setSession({ accountId: null });
    const res = await wrapToolError(
      Object.assign(new Error("Not Found"), { errors: [{ reason: "notFound" }] }),
      "get_thread",
      null,
    );
    expect(res.content[0].text).toContain("the active account");
    expect(res.content[0].text).toContain("gmail account auth");
  });
});

afterEach(() => {
  _resetForTests();
});
