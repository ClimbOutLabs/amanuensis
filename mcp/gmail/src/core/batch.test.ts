import { describe, expect, it, vi } from "vitest";
import { processBatches } from "./batch.js";

describe("processBatches", () => {
  it("splits items into batches of the requested size", async () => {
    const processFn = vi.fn(async (b: number[]) => b.map((n) => n * 2));
    const result = await processBatches([1, 2, 3, 4, 5], 2, processFn, { toolName: "t" });
    expect(processFn).toHaveBeenCalledTimes(3);
    expect(processFn).toHaveBeenNthCalledWith(1, [1, 2]);
    expect(processFn).toHaveBeenNthCalledWith(2, [3, 4]);
    expect(processFn).toHaveBeenNthCalledWith(3, [5]);
    expect(result.successes).toEqual([2, 4, 6, 8, 10]);
    expect(result.failures).toEqual([]);
  });

  it("falls back to per-item on batch failure and reports partials", async () => {
    // First call (batch) throws; per-item retries succeed for item 1, fail for item 2.
    let call = 0;
    const processFn = async (batch: number[]): Promise<number[]> => {
      call += 1;
      if (call === 1 && batch.length > 1) throw new Error("batch boom");
      if (batch[0] === 2) throw new Error("item 2 broken");
      return batch.map((n) => n * 10);
    };
    const result = await processBatches([1, 2, 3], 3, processFn, { toolName: "x" });
    expect(result.successes).toEqual([10, 30]);
    expect(result.failures).toEqual([{ item: 2, error: expect.any(Error), batchIndex: 0 }]);
    expect(result.failures[0].error.message).toBe("item 2 broken");
    expect(result.batchesTotal).toBe(1);
    expect(result.batchesCompleted).toBe(1);
    expect(result.itemsTotal).toBe(3);
    expect(result.aborted).toBe(false);
  });

  it("respects AbortSignal between batches", async () => {
    const controller = new AbortController();
    const processFn = vi.fn(async (b: number[]) => {
      // Abort after the first batch completes
      if (b[0] === 1) controller.abort();
      return b.map((n) => n * 2);
    });
    const result = await processBatches([1, 2, 3, 4], 2, processFn, {
      toolName: "abortable",
      signal: controller.signal,
    });
    expect(result.successes).toEqual([2, 4]);
    expect(processFn).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
    expect(result.batchesTotal).toBe(2);
    expect(result.batchesCompleted).toBe(1);
  });

  it("returns empty result for empty input", async () => {
    const result = await processBatches([], 5, async (b) => b, { toolName: "empty" });
    expect(result).toEqual({
      successes: [],
      failures: [],
      batchesTotal: 0,
      batchesCompleted: 0,
      itemsTotal: 0,
      aborted: false,
    });
  });
});
