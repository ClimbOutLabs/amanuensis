import { describe, expect, it } from "vitest";
import {
  COMPACT_BREAKPOINT,
  computeLayout,
  DETAIL_MAX_WIDTH,
  WIDE_BREAKPOINT,
} from "./responsive-layout.js";

describe("computeLayout", () => {
  it("compact tier (80 cols): squeezes everything but keeps minimums", () => {
    const w = computeLayout(80);
    expect(w.sidebar).toBe(22);
    expect(w.threadList).toBeGreaterThanOrEqual(32);
    expect(w.detail).toBeGreaterThanOrEqual(50);
  });

  it("compact tier (120 cols): detail wins the share split", () => {
    const w = computeLayout(120);
    expect(w.sidebar).toBe(22);
    expect(w.detail).toBeGreaterThan(w.threadList);
  });

  it("comfortable tier (160 cols): detail uncapped, threadList fixed 44", () => {
    const w = computeLayout(160);
    expect(w.sidebar).toBe(24);
    expect(w.threadList).toBe(44);
    expect(w.detail).toBeLessThanOrEqual(DETAIL_MAX_WIDTH);
    expect(w.detail).toBe(160 - 24 - 44);
  });

  it("comfortable tier upper bound (180 cols): detail hits the cap", () => {
    const w = computeLayout(180);
    expect(w.detail).toBe(DETAIL_MAX_WIDTH);
  });

  it("wide tier (240 cols): detail pegged at cap, surplus → threadList", () => {
    const w = computeLayout(240);
    expect(w.sidebar).toBe(28);
    expect(w.detail).toBe(DETAIL_MAX_WIDTH);
    // 240 - 28 - 100 = 112 surplus, capped at 80
    expect(w.threadList).toBe(80);
  });

  it("ultrawide (340 cols): threadList caps at 80, surplus unused", () => {
    const w = computeLayout(340);
    expect(w.threadList).toBe(80);
    expect(w.sidebar + w.threadList + w.detail).toBeLessThan(340);
  });

  it("degenerate zero cols → falls back to a sensible default layout", () => {
    const w = computeLayout(0);
    expect(w.sidebar).toBeGreaterThan(0);
    expect(w.threadList).toBeGreaterThan(0);
    expect(w.detail).toBeGreaterThan(0);
  });

  it("breakpoint constants are sane and ordered", () => {
    expect(COMPACT_BREAKPOINT).toBeLessThan(WIDE_BREAKPOINT);
  });
});
