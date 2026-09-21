import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READONLY_FALLBACK_SCOPES } from "../scopes.js";
import type { AccountChangedPayload } from "./session.js";
import {
  _resetForTests,
  getAuthorizedScopes,
  getGmail,
  getOAuth2Client,
  getRecentErrorCount,
  getToolCallCount,
  incrementToolCallCount,
  isSessionReady,
  recordToolError,
  sessionEvents,
  setAuthorizedScopes,
  setSession,
} from "./session.js";

const fakeOauth = { dummy: true } as any;
const fakeGmail = { users: {} } as any;

beforeEach(() => {
  _resetForTests();
});

describe("session ready state", () => {
  it("starts un-initialized", () => {
    expect(isSessionReady()).toBe(false);
    expect(() => getOAuth2Client()).toThrow(/Session not initialised/);
    expect(() => getGmail()).toThrow(/Session not initialised/);
  });

  it("is ready after setSession", () => {
    setSession({ oauth2Client: fakeOauth, gmail: fakeGmail });
    expect(isSessionReady()).toBe(true);
    expect(getOAuth2Client()).toBe(fakeOauth);
    expect(getGmail()).toBe(fakeGmail);
  });
});

describe("scopes", () => {
  it("defaults to the read-only fallback when no scope list is stored", () => {
    expect(getAuthorizedScopes()).toEqual(READONLY_FALLBACK_SCOPES);
  });

  it("setAuthorizedScopes overrides", () => {
    setAuthorizedScopes(["gmail.readonly"]);
    expect(getAuthorizedScopes()).toEqual(["gmail.readonly"]);
  });

  it("setSession can include scopes", () => {
    setSession({
      oauth2Client: fakeOauth,
      gmail: fakeGmail,
      authorizedScopes: ["gmail.modify"],
    });
    expect(getAuthorizedScopes()).toEqual(["gmail.modify"]);
  });
});

describe("counters", () => {
  it("tool call count starts at 0 and increments", () => {
    expect(getToolCallCount()).toBe(0);
    incrementToolCallCount();
    incrementToolCallCount();
    expect(getToolCallCount()).toBe(2);
  });

  it("recent error count uses a 5-minute sliding window", () => {
    // Record three errors "now"
    recordToolError();
    recordToolError();
    recordToolError();
    expect(getRecentErrorCount()).toBe(3);
  });

  it("evicts errors older than 5 minutes", () => {
    const realNow = Date.now;
    let now = 1_000_000_000_000;
    Date.now = () => now;
    try {
      recordToolError();
      recordToolError();
      // Advance time 10 minutes
      now += 10 * 60_000;
      recordToolError();
      expect(getRecentErrorCount()).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });
});

// ---------------------------------------------------------------------------
// sessionEvents.accountChanged (Pre-TUI Step 3)
// ---------------------------------------------------------------------------

describe("sessionEvents.accountChanged", () => {
  afterEach(() => {
    sessionEvents.removeAllListeners();
  });

  it("emits when accountId changes from null → 'work'", () => {
    const handler = vi.fn();
    sessionEvents.on("accountChanged", handler);

    setSession({
      oauth2Client: fakeOauth,
      gmail: fakeGmail,
      accountId: "work",
      authorizedScopes: ["gmail.modify"],
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const payload = handler.mock.calls[0]?.[0] as AccountChangedPayload;
    expect(payload).toEqual({
      previous: null,
      current: "work",
      scopes: ["gmail.modify"],
    });
  });

  it("emits when accountId changes between two named accounts", () => {
    setSession({
      oauth2Client: fakeOauth,
      gmail: fakeGmail,
      accountId: "work",
      authorizedScopes: ["gmail.modify"],
    });

    const handler = vi.fn();
    sessionEvents.on("accountChanged", handler);

    setSession({
      oauth2Client: fakeOauth,
      gmail: fakeGmail,
      accountId: "personal",
      authorizedScopes: ["gmail.readonly"],
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual({
      previous: "work",
      current: "personal",
      scopes: ["gmail.readonly"],
    });
  });

  it("does NOT emit when the same accountId is set twice", () => {
    setSession({ oauth2Client: fakeOauth, gmail: fakeGmail, accountId: "work" });

    const handler = vi.fn();
    sessionEvents.on("accountChanged", handler);

    setSession({ oauth2Client: fakeOauth, gmail: fakeGmail, accountId: "work" });

    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT emit when accountId is omitted (legacy single-account bootstrap)", () => {
    const handler = vi.fn();
    sessionEvents.on("accountChanged", handler);

    setSession({ oauth2Client: fakeOauth, gmail: fakeGmail });

    expect(handler).not.toHaveBeenCalled();
  });

  it("emits when accountId is explicitly set to null (env-driven mode)", () => {
    setSession({ oauth2Client: fakeOauth, gmail: fakeGmail, accountId: "work" });

    const handler = vi.fn();
    sessionEvents.on("accountChanged", handler);

    setSession({ oauth2Client: fakeOauth, gmail: fakeGmail, accountId: null });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ previous: "work", current: null }),
    );
  });

  it("fans out to multiple subscribers", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    sessionEvents.on("accountChanged", h1);
    sessionEvents.on("accountChanged", h2);

    setSession({ oauth2Client: fakeOauth, gmail: fakeGmail, accountId: "alpha" });

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("_resetForTests clears listeners (no cross-test leak)", () => {
    const handler = vi.fn();
    sessionEvents.on("accountChanged", handler);
    _resetForTests();

    setSession({ oauth2Client: fakeOauth, gmail: fakeGmail, accountId: "work" });

    expect(handler).not.toHaveBeenCalled();
  });
});
