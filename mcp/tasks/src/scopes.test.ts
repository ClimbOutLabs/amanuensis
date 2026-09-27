// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
// Unit tests for the tasks scope helpers.
//
// Key property under test: a missing scope list on legacy credentials must
// NOT be promoted to the OAuth request default. Enforcement treats missing
// scopes as unknown, and the server then applies READONLY_FALLBACK_SCOPES.

import { describe, expect, test } from "vitest";
import {
  DEFAULT_SCOPES,
  READONLY_FALLBACK_SCOPES,
  hasScope,
  scopeNameToUrl,
  scopeUrlToName,
} from "./core/scopes.js";

describe("scope helpers", () => {
  test("map shorthand to full URLs and back", () => {
    expect(scopeNameToUrl("tasks")).toBe("https://www.googleapis.com/auth/tasks");
    expect(scopeNameToUrl("tasks.readonly")).toBe("https://www.googleapis.com/auth/tasks.readonly");
    expect(scopeUrlToName("https://www.googleapis.com/auth/tasks")).toBe("tasks");
    expect(scopeUrlToName("https://www.googleapis.com/auth/tasks.readonly")).toBe("tasks.readonly");
  });

  test("read tools need tasks.readonly", () => {
    expect(hasScope(["tasks.readonly"], ["tasks.readonly"])).toBe(true);
    expect(hasScope(["tasks"], ["tasks.readonly"])).toBe(true);
    expect(hasScope([], ["tasks.readonly"])).toBe(false);
  });

  test("write tools need tasks", () => {
    expect(hasScope(["tasks.readonly"], ["tasks"])).toBe(false);
    expect(hasScope(["tasks"], ["tasks"])).toBe(true);
  });

  test("readonly fallback is least privilege", () => {
    expect(READONLY_FALLBACK_SCOPES).toEqual(["tasks.readonly"]);
    expect(DEFAULT_SCOPES).toContain("tasks");
    expect(READONLY_FALLBACK_SCOPES).not.toContain("tasks");
    // A legacy credential with no scope list gets read-only only.
    expect(hasScope(READONLY_FALLBACK_SCOPES, ["tasks"])).toBe(false);
    expect(hasScope(READONLY_FALLBACK_SCOPES, ["tasks.readonly"])).toBe(true);
  });
});
