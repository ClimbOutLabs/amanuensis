// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCOPES,
  hasScope,
  READONLY_FALLBACK_SCOPES,
  scopeNameToUrl,
  scopeNamesToUrls,
  scopeUrlToName,
} from "./core/scopes.js";

describe("scope maps", () => {
  it("maps shorthand names to Google URLs", () => {
    expect(scopeNameToUrl("calendar.readonly")).toBe("https://www.googleapis.com/auth/calendar.readonly");
    expect(scopeNameToUrl("calendar.events")).toBe("https://www.googleapis.com/auth/calendar.events");
  });

  it("round-trips URLs back to shorthand", () => {
    expect(scopeUrlToName("https://www.googleapis.com/auth/calendar.readonly")).toBe("calendar.readonly");
  });

  it("passes through unknown scopes unchanged", () => {
    expect(scopeNameToUrl("custom")).toBe("custom");
    expect(scopeUrlToName("custom")).toBe("custom");
  });

  it("converts the default request set", () => {
    expect(scopeNamesToUrls(DEFAULT_SCOPES)).toEqual([
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ]);
  });
});

describe("hasScope", () => {
  it("allows tools that need no scope", () => {
    expect(hasScope([], [])).toBe(true);
  });

  it("grants read tools with calendar.readonly", () => {
    expect(hasScope(["calendar.readonly"], ["calendar.readonly"])).toBe(true);
  });

  it("denies write tools without calendar.events", () => {
    expect(hasScope(["calendar.readonly"], ["calendar.events"])).toBe(false);
  });

  it("grants write tools with calendar.events", () => {
    expect(hasScope(["calendar.readonly", "calendar.events"], ["calendar.events"])).toBe(true);
  });

  it("treats the full calendar scope as a superset", () => {
    expect(hasScope(["calendar"], ["calendar.readonly"])).toBe(true);
    expect(hasScope(["calendar"], ["calendar.events"])).toBe(true);
  });

  it("normalizes full URLs before comparing", () => {
    expect(hasScope(["https://www.googleapis.com/auth/calendar.events"], ["calendar.events"])).toBe(true);
  });

  it("falls back to read-only when no scope list was stored", () => {
    expect(hasScope(READONLY_FALLBACK_SCOPES, ["calendar.readonly"])).toBe(true);
    expect(hasScope(READONLY_FALLBACK_SCOPES, ["calendar.events"])).toBe(false);
  });
});
