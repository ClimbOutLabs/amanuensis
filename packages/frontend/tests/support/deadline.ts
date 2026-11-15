/**
 * Ends a browser test that has stopped moving. node:test's own timeout marks the test failed but
 * leaves its browser and servers open, so the run never ends and nothing says where it stopped.
 * This fails the test from the inside instead, so its clean-up runs and its failure pictures are saved.
 */
export async function withinDeadline<T>({
  ms,
  where,
  run,
}: {
  ms: number;
  /** The step the test is on, named in the failure. */
  where: () => string;
  run: () => Promise<T>;
}): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `The test did not finish within ${String(Math.round(ms / 1000))} seconds. It stopped at: ${where()}. Look at the FAILED pictures saved with this run to see the page at that moment.`,
        ),
      );
    }, ms);
  });
  try {
    return await Promise.race([run(), late]);
  } finally {
    clearTimeout(timer);
  }
}
