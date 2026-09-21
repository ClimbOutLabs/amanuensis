// L3: recent-error timestamps are pruned on record and on read.
//
// health_check reports recentErrors over a rolling window; without pruning
// on both paths the array grows unboundedly between health checks and the
// count goes stale.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetForTests,
  getRecentErrorCount,
  recordToolError,
} from "../../src/core/session.js";

afterEach(() => {
  _resetForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("recent error pruning (L3)", () => {
  it("counts errors inside the rolling window", () => {
    recordToolError();
    recordToolError();
    expect(getRecentErrorCount()).toBe(2);
  });

  it("drops errors older than the window on read", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00Z"));
    recordToolError();
    // Advance past the rolling window (5 minutes).
    vi.setSystemTime(new Date("2026-09-19T10:06:00Z"));
    expect(getRecentErrorCount()).toBe(0);
  });

  it("prunes on record so the array stays bounded without reads", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00Z"));
    for (let i = 0; i < 50; i += 1) recordToolError();
    expect(getRecentErrorCount()).toBe(50);
    // All old; the next record prunes them before appending.
    vi.setSystemTime(new Date("2026-09-19T10:06:00Z"));
    recordToolError();
    expect(getRecentErrorCount()).toBe(1);
  });

  it("keeps recent errors while dropping only the expired ones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00Z"));
    recordToolError();
    vi.setSystemTime(new Date("2026-09-19T10:04:00Z"));
    recordToolError();
    vi.setSystemTime(new Date("2026-09-19T10:06:00Z"));
    expect(getRecentErrorCount()).toBe(1);
  });
});
