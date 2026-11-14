/**
 * Memory work that is started without being waited for (sorting saved notes onto pages, indexing them for
 * search) still writes into the memory folder. It is counted here so shutdown can let it finish first.
 */
const inFlight = new Set<Promise<unknown>>();

/** Counts `work` until it settles, and hands it back. Its outcome stays the caller's to handle. */
export function trackMemoryBackgroundWork<T>(work: Promise<T>): Promise<T> {
  inFlight.add(work);
  const done = (): void => {
    inFlight.delete(work);
  };
  void work.then(done, done);
  return work;
}

/**
 * Waits until no counted work is running, giving up after `timeoutMs` so a stuck model call cannot hang
 * shutdown. Work that starts while waiting is waited for too. Work cut off here loses nothing: unsorted
 * notes wait for the daily tidy and the search index is rebuilt on the next start. Never throws.
 */
export async function memoryBackgroundWorkSettled({ timeoutMs }: { timeoutMs: number }): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return;
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(Array.from(inFlight)),
        new Promise<void>(resolve => {
          timeout = setTimeout(resolve, remainingMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
}
