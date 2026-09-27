// Unit tests for src/scopes.ts.
//
// Covers scope matching, shorthand/URL conversion, parsing, validation, and
// available-scope enumeration.

import { describe, expect, it } from "vitest";
import {
  getAvailableScopeNames,
  hasScope,
  parseScopes,
  SCOPE_MAP,
  scopeNamesToUrls,
  scopeNameToUrl,
  scopeUrlToName,
  validateScopes,
} from "./scopes.js";

describe("hasScope (8.4)", () => {
  it("returns true when required scopes list is empty (health_check case)", () => {
    expect(hasScope([], [])).toBe(true);
    expect(hasScope(["gmail.modify"], [])).toBe(true);
  });

  it("accepts shorthand-shorthand match", () => {
    expect(hasScope(["gmail.modify"], ["gmail.modify"])).toBe(true);
  });

  it("normalises URL-shaped authorized scopes to shorthand before comparison", () => {
    expect(hasScope(["https://www.googleapis.com/auth/gmail.modify"], ["gmail.modify"])).toBe(true);
  });

  it("returns true when ANY required scope is satisfied (OR semantics)", () => {
    expect(hasScope(["gmail.send"], ["gmail.send", "gmail.compose"])).toBe(true);
  });

  it("returns false when no required scope is present", () => {
    expect(hasScope(["gmail.readonly"], ["gmail.send"])).toBe(false);
  });

  it("returns false when authorized list is empty but a scope is required", () => {
    expect(hasScope([], ["gmail.modify"])).toBe(false);
  });

  it("treats gmail.full as a superset of mail scopes but not settings scopes", () => {
    for (const scope of [
      "gmail.readonly",
      "gmail.modify",
      "gmail.compose",
      "gmail.send",
      "gmail.labels",
      "gmail.full",
    ]) {
      expect(hasScope(["gmail.full"], [scope])).toBe(true);
    }
    expect(hasScope(["https://mail.google.com/"], ["gmail.modify"])).toBe(true);
    expect(hasScope(["gmail.full"], ["gmail.settings.basic"])).toBe(false);
  });
});

describe("scopeNameToUrl / scopeUrlToName / scopeNamesToUrls (8.5)", () => {
  it("scopeNameToUrl maps known shorthand → URL", () => {
    expect(scopeNameToUrl("gmail.readonly")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(scopeNameToUrl("gmail.modify")).toBe("https://www.googleapis.com/auth/gmail.modify");
  });

  it("scopeNameToUrl passes unknown input through unchanged", () => {
    expect(scopeNameToUrl("gmail.bogus")).toBe("gmail.bogus");
    // Already-URL input is also unknown to the map, so it falls through.
    const url = "https://www.googleapis.com/auth/gmail.readonly";
    expect(scopeNameToUrl(url)).toBe(url);
  });

  it("scopeUrlToName maps known URL → shorthand", () => {
    expect(scopeUrlToName("https://www.googleapis.com/auth/gmail.send")).toBe("gmail.send");
  });

  it("scopeUrlToName passes unknown input through unchanged", () => {
    expect(scopeUrlToName("https://www.googleapis.com/auth/gmail.nope")).toBe(
      "https://www.googleapis.com/auth/gmail.nope",
    );
    expect(scopeUrlToName("gmail.readonly")).toBe("gmail.readonly");
  });

  it("round-trips shorthand → URL → shorthand for every known scope", () => {
    for (const name of Object.keys(SCOPE_MAP)) {
      expect(scopeUrlToName(scopeNameToUrl(name))).toBe(name);
    }
  });

  it("scopeNamesToUrls maps each entry through scopeNameToUrl", () => {
    expect(scopeNamesToUrls(["gmail.modify", "gmail.settings.basic"])).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.settings.basic",
    ]);
  });

  it("scopeNamesToUrls preserves empty input", () => {
    expect(scopeNamesToUrls([])).toEqual([]);
  });
});

describe("parseScopes (8.6)", () => {
  it("splits comma-separated input", () => {
    expect(parseScopes("gmail.modify,gmail.send")).toEqual(["gmail.modify", "gmail.send"]);
  });

  it("splits whitespace-separated input", () => {
    expect(parseScopes("gmail.modify gmail.send")).toEqual(["gmail.modify", "gmail.send"]);
  });

  it("handles mixed comma + whitespace and trims entries", () => {
    expect(parseScopes("gmail.modify, gmail.send  gmail.compose")).toEqual([
      "gmail.modify",
      "gmail.send",
      "gmail.compose",
    ]);
  });

  it("drops empty entries from leading/trailing/duplicated separators", () => {
    expect(parseScopes(", gmail.modify ,, gmail.send ,")).toEqual(["gmail.modify", "gmail.send"]);
  });

  it("returns empty array for empty/whitespace-only input", () => {
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes("   ")).toEqual([]);
    expect(parseScopes(",,,")).toEqual([]);
  });
});

describe("validateScopes (8.7)", () => {
  it("returns valid=true with empty invalid[] for all-known scopes", () => {
    expect(validateScopes(["gmail.modify", "gmail.send"])).toEqual({
      valid: true,
      invalid: [],
    });
  });

  it("returns valid=true for empty input", () => {
    expect(validateScopes([])).toEqual({ valid: true, invalid: [] });
  });

  it("returns valid=false and lists unknown shorthand entries", () => {
    expect(validateScopes(["gmail.modify", "gmail.fake", "gmail.bogus"])).toEqual({
      valid: false,
      invalid: ["gmail.fake", "gmail.bogus"],
    });
  });

  it("treats URL-shaped scopes as invalid (validator works against shorthand only)", () => {
    const result = validateScopes(["https://www.googleapis.com/auth/gmail.modify"]);
    expect(result.valid).toBe(false);
    expect(result.invalid).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);
  });
});

describe("getAvailableScopeNames (8.8)", () => {
  it("returns the full set of recognised shorthand names", () => {
    const names = getAvailableScopeNames();
    expect(names).toEqual(Object.keys(SCOPE_MAP));
    // Spot-check that the documented default scopes are present.
    expect(names).toContain("gmail.modify");
    expect(names).toContain("gmail.settings.basic");
    expect(names).toContain("gmail.readonly");
    expect(names).toContain("gmail.send");
    expect(names).toContain("gmail.compose");
    expect(names).toContain("gmail.labels");
  });

  it("every returned name is itself a valid scope", () => {
    const names = getAvailableScopeNames();
    expect(validateScopes(names)).toEqual({ valid: true, invalid: [] });
  });
});
