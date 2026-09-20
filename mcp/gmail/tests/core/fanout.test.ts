// Focused tests for the bounded fan-out helper (core/fanout.ts): transient
// retry behaviour, 404-skip, order preservation, and the concurrency bound.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fanoutMap, isNotFoundError, isRetryableGmailError } from "../../src/core/fanout.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  // Keep retry backoff near-instant so these tests stay fast.
  vi.stubEnv("MCP_RETRY_BASE_MS", "1");
  vi.stubEnv("MCP_RETRY_CAP_MS", "5");
  vi.stubEnv("MCP_RETRY_MAX_ATTEMPTS", "4");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function gmailError(code: number, extra: Record<string, unknown> = {}): Error & { code: number } {
  return Object.assign(new Error(`gmail ${code}`), { code }, extra);
}

describe("isRetryableGmailError", () => {
  it("retries 429 and 5xx", () => {
    expect(isRetryableGmailError(gmailError(429))).toBe(true);
    expect(isRetryableGmailError(gmailError(500))).toBe(true);
    expect(isRetryableGmailError(gmailError(503))).toBe(true);
  });

  it("retries Google's 403 rate-limit/quota responses", () => {
    expect(
      isRetryableGmailError(
        gmailError(403, { errors: [{ reason: "rateLimitExceeded" }] }),
      ),
    ).toBe(true);
    expect(
      isRetryableGmailError(
        gmailError(403, { errors: [{ reason: "quotaExceeded" }] }),
      ),
    ).toBe(true);
  });

  it("does not retry auth 403s or client errors", () => {
    expect(isRetryableGmailError(gmailError(403))).toBe(false);
    expect(
      isRetryableGmailError(
        gmailError(403, { message: "Request had insufficient authentication scopes." }),
      ),
    ).toBe(false);
    expect(isRetryableGmailError(gmailError(400))).toBe(false);
    expect(isRetryableGmailError(gmailError(404))).toBe(false);
  });
});

describe("fanoutMap", () => {
  it("retries a transient 429 then returns the result", async () => {
    let calls = 0;
    const out = await fanoutMap(["a"], async () => {
      calls += 1;
      if (calls < 3) throw gmailError(429);
      return "ok";
    });
    expect(out).toEqual(["ok"]);
    expect(calls).toBe(3);
  });

  it("retries a 403 rateLimitExceeded then succeeds", async () => {
    let calls = 0;
    const out = await fanoutMap(["a"], async () => {
      calls += 1;
      if (calls === 1) throw gmailError(403, { errors: [{ reason: "rateLimitExceeded" }] });
      return "ok";
    });
    expect(out).toEqual(["ok"]);
    expect(calls).toBe(2);
  });

  it("fails fast on a non-rate-limit 403 (no retry)", async () => {
    let calls = 0;
    await expect(
      fanoutMap(["a"], async () => {
        calls += 1;
        throw gmailError(403, { message: "insufficientPermissions" });
      }),
    ).rejects.toThrow("insufficientPermissions");
    expect(calls).toBe(1);
  });

  it("does not retry permanent errors", async () => {
    let calls = 0;
    await expect(
      fanoutMap(["a"], async () => {
        calls += 1;
        throw gmailError(400);
      }),
    ).rejects.toThrow("gmail 400");
    expect(calls).toBe(1);
  });

  it("gives up after the attempt budget on persistent transient errors", async () => {
    let calls = 0;
    await expect(
      fanoutMap(["a"], async () => {
        calls += 1;
        throw gmailError(503);
      }),
    ).rejects.toThrow("gmail 503");
    expect(calls).toBe(4); // MCP_RETRY_MAX_ATTEMPTS stubbed above
  });

  it("skips 404 rows (deleted between list and get) and preserves order", async () => {
    const out = await fanoutMap([1, 2, 3, 4], async (n) => {
      if (n === 2) throw gmailError(404);
      if (n === 3) throw Object.assign(new Error("gone"), { errors: [{ reason: "notFound" }] });
      return `row-${n}`;
    });
    expect(out).toEqual(["row-1", "row-4"]);
    expect(isNotFoundError(gmailError(404))).toBe(true);
  });

  it("bounds in-flight calls at the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [1, 2, 3, 4, 5, 6];
    const out = await fanoutMap(
      items,
      async (n) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(10);
        inFlight -= 1;
        return n * 2;
      },
      { concurrency: 2 },
    );
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1); // workers actually ran in parallel
  });

  it("maps an empty list to an empty list without calling fn", async () => {
    const fn = vi.fn();
    await expect(fanoutMap([], fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
