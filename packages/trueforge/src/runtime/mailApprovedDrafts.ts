import type {
  ApprovedMailDraft,
  ApprovedMailDrafts,
} from '@truefoundry/trueforge-core/core/email/mailConnector/approvedDrafts';
import { createHash, randomUUID } from 'crypto';
import { open, readFile, rename, rm } from 'fs/promises';
import { dirname, join } from 'path';

const DRAFTS_FILE_NAME = 'approved_drafts.json';

/** An approved draft nobody sent is forgotten after this long, so the file does not grow without end. */
const KEPT_FOR_MS = 30 * 24 * 60 * 60 * 1000;

/** Where the approved drafts live, from the sidecar list file's path. */
export function approvedMailDraftsPath(policyPath: string): string {
  return join(dirname(policyPath), DRAFTS_FILE_NAME);
}

/** Only a digest is kept: the file never holds an address, a subject or a word of a message. */
function entryId(input: ApprovedMailDraft): string {
  return createHash('sha256')
    .update(JSON.stringify([input.tenant_id, input.created_by, input.key]))
    .digest('hex');
}

/** The drafts the file holds, by digest, with when each was approved. A missing or damaged file holds none. */
async function readEntries(path: string): Promise<Map<string, number>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return new Map();
  }
  const entries = new Map<string, number>();
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    for (const [id, at] of Object.entries(parsed)) {
      if (typeof at === 'number') {
        entries.set(id, at);
      }
    }
  }
  return entries;
}

async function writeEntries({ path, entries }: { path: string; entries: ReadonlyMap<string, number> }): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(Object.fromEntries(entries))}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Approved drafts kept in a file, so a draft approved before a restart can still be sent after it.
 * A file that cannot be read approves nothing, so a damaged file stops sends instead of opening them.
 */
export function fileApprovedMailDrafts({
  path,
  now = () => Date.now(),
}: {
  path: string;
  now?: () => number;
}): ApprovedMailDrafts {
  // One change at a time, so two answers arriving together cannot drop each other's entry.
  let last: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = last.then(work, work);
    last = next.catch(() => undefined);
    return next;
  };
  const current = async (): Promise<Map<string, number>> => {
    const entries = await readEntries(path);
    for (const [id, at] of entries) {
      if (now() - at > KEPT_FOR_MS) {
        entries.delete(id);
      }
    }
    return entries;
  };
  return {
    has: input => inTurn(async () => (await current()).has(entryId(input))),
    add: input =>
      inTurn(async () => {
        const entries = await current();
        entries.set(entryId(input), now());
        await writeEntries({ path, entries });
      }),
    remove: input =>
      inTurn(async () => {
        const entries = await current();
        if (entries.delete(entryId(input))) {
          await writeEntries({ path, entries });
        }
      }),
  };
}
