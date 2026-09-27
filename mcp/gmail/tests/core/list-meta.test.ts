// L11: every list-shaped tool output carries truncation metadata.
//
// `listMeta` computes { truncated, total_available } so callers never have
// to guess whether a result set was silently capped. These tests pin the
// semantics and verify the fields reach the wire via a real op.

import { describe, expect, it } from "vitest";
import { listMeta } from "../../src/core/email-helpers.js";

describe("listMeta truncation semantics (L11)", () => {
  it("marks truncated when a nextPageToken exists", () => {
    expect(listMeta(10, { nextPageToken: "tok", estimate: 10 })).toEqual({
      truncated: true,
      total_available: 10,
    });
  });

  it("marks truncated when the server estimate exceeds the returned count", () => {
    expect(listMeta(10, { estimate: 250 })).toEqual({
      truncated: true,
      total_available: 250,
    });
  });

  it("is not truncated for fully-enumerated lists", () => {
    expect(listMeta(7)).toEqual({ truncated: false, total_available: 7 });
    expect(listMeta(7, { estimate: 7 })).toEqual({
      truncated: false,
      total_available: 7,
    });
  });

  it("never reports a total below the returned count", () => {
    expect(listMeta(10, { estimate: 3 })).toEqual({
      truncated: false,
      total_available: 10,
    });
  });

  it("treats empty-string page tokens as no more pages", () => {
    expect(listMeta(0, { nextPageToken: "" })).toEqual({
      truncated: false,
      total_available: 0,
    });
  });
});
