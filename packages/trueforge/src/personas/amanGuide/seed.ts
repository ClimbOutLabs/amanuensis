import type { Logger } from 'winston';

/**
 * Refreshes the guide of every person who already owns one. A failed listing is logged and boot goes on;
 * a failed install for one person is logged by the seeder and does not stop the others.
 */
export async function seedExistingGuides({
  listOwners,
  seed,
  logger,
}: {
  listOwners: () => Promise<string[]>;
  seed: (userId: string) => Promise<void>;
  logger: Logger;
}): Promise<void> {
  let owners: string[];
  try {
    owners = await listOwners();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('Iris could not be refreshed at startup. She will be refreshed when each person next uses Aman.', {
      reason,
    });
    return;
  }
  await Promise.all(owners.map(userId => seed(userId)));
}

/**
 * Runs the guide install at most once per person for this process, and never rejects. A failure is
 * logged once; the next start of the server tries again, so a broken install never blocks boot or sign-in.
 */
export function createGuideSeeder({ logger }: { logger: Logger }) {
  const runs = new Map<string, Promise<void>>();
  const seed = (userId: string, install: () => Promise<void>): Promise<void> => {
    const existing = runs.get(userId);
    if (existing !== undefined) {
      return existing;
    }
    const run = Promise.resolve()
      .then(install)
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn('Iris could not be set up. Aman will try again the next time the server starts.', { reason });
      });
    runs.set(userId, run);
    return run;
  };
  /** Resolves once every install started so far has finished, so a test can tear down its files safely. */
  const settled = async (): Promise<void> => {
    let awaited = -1;
    while (awaited !== runs.size) {
      awaited = runs.size;
      await Promise.all([...runs.values()]);
    }
  };
  return Object.assign(seed, { settled });
}
