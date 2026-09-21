// Handler-level tests for src/core/ops/health.ts.
//
// Covers health_check text/structured output plus degraded/unhealthy branches
// driven by event-loop p99 and watchdog kill reasons.
//
// Strategy: partially mock @george43g/robustness so readWatchdogState()
// returns driver-supplied state. The op passes that state explicitly into the
// REAL snapshotHealth (its injectable-state param landed in robustness
// 0.10.0 at this repo's request), so the package's actual status ladder is
// exercised against synthetic watchdog conditions. Side-effect import of
// ./health.js registers the op; we dispatch through the registry singleton
// with a stub context (the handler never touches ctx.gmail).

import type { WatchdogState } from "@george43g/robustness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationContext } from "../context.js";
import { registry } from "../registry.js";
import { _resetForTests, incrementToolCallCount, recordToolError } from "../session.js";

// Mocked watchdog state — mutated by individual tests, then handed to the
// real snapshotHealth via the mocked readWatchdogState().
const mockState = vi.hoisted(
  (): WatchdogState => ({
    startedAt: Date.now(),
    eventLoopP99Ms: 0,
    eventLoopMaxMs: 0,
    eventLoopSustainedCount: 0,
    lastEventLoopSampleTs: Date.now(),
    rssMb: 0,
    heapMb: 0,
    heapHistory: [],
    lastActivityTs: Date.now(),
    killReason: null,
    memorySampled: false,
  }),
);

vi.mock("@george43g/robustness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@george43g/robustness")>()),
  readWatchdogState: () => mockState,
}));

// Side-effect: registers the health_check op on the registry singleton.
await import("./health.js");

function makeCtx(): OperationContext {
  // health_check never touches ctx.gmail / ctx.oauth2Client, so these are
  // intentionally untyped stubs cast to the interface.
  return {
    gmail: {} as OperationContext["gmail"],
    oauth2Client: {} as OperationContext["oauth2Client"],
    authorizedScopes: [],
    toolName: "health_check",
    accountId: null,
  };
}

function resetMockState(): void {
  const now = Date.now();
  mockState.startedAt = now;
  mockState.eventLoopP99Ms = 0;
  mockState.eventLoopMaxMs = 0;
  mockState.eventLoopSustainedCount = 0;
  mockState.lastEventLoopSampleTs = now;
  mockState.rssMb = 0;
  mockState.heapMb = 0;
  mockState.heapHistory = [];
  mockState.lastActivityTs = now;
  mockState.killReason = null;
  mockState.memorySampled = false;
}

describe("health_check handler (8.1)", () => {
  beforeEach(() => {
    resetMockState();
    _resetForTests();
  });

  afterEach(() => {
    _resetForTests();
  });

  it("returns healthy when watchdog is quiet and no recent errors", async () => {
    const result = await registry.dispatch("health_check", {}, makeCtx());

    expect(result.content[0].text).toContain("Status: healthy");
    expect(result.content[0].text).not.toContain("Issues:");

    // structuredContent (typed output) reflects the snapshot.
    const sc = result.structuredContent as {
      status: string;
      issues: string[];
      tool_calls: number;
      recent_errors: number;
      pid: number;
    };
    expect(sc.status).toBe("healthy");
    expect(sc.issues).toEqual([]);
    expect(sc.tool_calls).toBe(0);
    expect(sc.recent_errors).toBe(0);
    expect(sc.pid).toBe(process.pid);
  });

  it("threads session counters (tool_calls + recent_errors) into the snapshot", async () => {
    incrementToolCallCount();
    incrementToolCallCount();
    incrementToolCallCount();
    recordToolError();
    recordToolError();

    const result = await registry.dispatch("health_check", {}, makeCtx());
    const sc = result.structuredContent as { tool_calls: number; recent_errors: number };
    expect(sc.tool_calls).toBe(3);
    expect(sc.recent_errors).toBe(2);
  });

  it("returns degraded when event-loop p99 is in [500ms, 5000ms)", async () => {
    mockState.eventLoopP99Ms = 750;

    const result = await registry.dispatch("health_check", {}, makeCtx());

    expect(result.content[0].text).toContain("Status: degraded");
    expect(result.content[0].text).toContain("Issues: event loop p99 750ms");
    const sc = result.structuredContent as { status: string; issues: string[] };
    expect(sc.status).toBe("degraded");
    expect(sc.issues).toEqual(["event loop p99 750ms"]);
  });

  it("returns degraded when recent errors >= 5 and event-loop is quiet", async () => {
    for (let i = 0; i < 5; i++) recordToolError();

    const result = await registry.dispatch("health_check", {}, makeCtx());

    const sc = result.structuredContent as {
      status: string;
      issues: string[];
      recent_errors: number;
    };
    expect(sc.status).toBe("degraded");
    expect(sc.recent_errors).toBe(5);
    expect(sc.issues.some((i) => i.includes("5 recent errors"))).toBe(true);
  });
});

describe("snapshotHealth unhealthy branches (8.2)", () => {
  beforeEach(() => {
    resetMockState();
    _resetForTests();
  });

  afterEach(() => {
    _resetForTests();
  });

  it("returns unhealthy when event-loop p99 >= 5000ms", async () => {
    mockState.eventLoopP99Ms = 5000;

    const result = await registry.dispatch("health_check", {}, makeCtx());

    const sc = result.structuredContent as { status: string; issues: string[] };
    expect(sc.status).toBe("unhealthy");
    expect(sc.issues).toEqual(["event loop p99 5000ms"]);
    expect(result.content[0].text).toContain("Status: unhealthy");
  });

  it("returns unhealthy when watchdog killReason is set (overrides healthy)", async () => {
    mockState.killReason = "rss_exceeded";

    const result = await registry.dispatch("health_check", {}, makeCtx());

    const sc = result.structuredContent as { status: string; issues: string[] };
    expect(sc.status).toBe("unhealthy");
    expect(sc.issues).toContain("watchdog kill: rss_exceeded");
    expect(result.content[0].text).toContain("Status: unhealthy");
    expect(result.content[0].text).toContain("Issues: watchdog kill: rss_exceeded");
  });

  it("killReason promotes degraded → unhealthy and both issues are listed", async () => {
    mockState.eventLoopP99Ms = 750; // degraded on its own
    mockState.killReason = "event_loop_blocked";

    const result = await registry.dispatch("health_check", {}, makeCtx());

    const sc = result.structuredContent as { status: string; issues: string[] };
    expect(sc.status).toBe("unhealthy");
    // Both issues recorded — event-loop pushed in first, killReason second.
    expect(sc.issues).toEqual(["event loop p99 750ms", "watchdog kill: event_loop_blocked"]);
  });
});
