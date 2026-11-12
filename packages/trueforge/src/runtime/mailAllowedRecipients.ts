import { createHash, randomUUID } from 'crypto';
import { open, readFile, rename, rm } from 'fs/promises';

import { normalizeMailAddress } from '@truefoundry/trueforge-core/core/email/mailConnector/recipientList';

/**
 * An exact mailbox made of ASCII letters, digits and `._%+-`, then `@`, then dot-separated domain labels.
 * Anything outside that set is refused, so no glob character, quote, backslash or space can reach the file.
 */
const EXACT_ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Where the sidecar keeps its mail index. The sidecar's config file is this file, and the index path can
 * only be set inside it, so the server writes it here. It is the sidecar's own volume path, not the server's.
 */
export const MAIL_INDEX_DB_LOCATION = '/data/db.sqlite3';

/** The one shape the server reads back. Any other content reads as an empty list. */
const FILE_SHAPE = /^db_location = "([^"]*)"\nallowed_recipients = \[(.*)\]\n?$/;

/** Returns the normalized address, or null when the value is not one exact mailbox. */
export function exactRecipientAddress(raw: string): string | null {
  const address = normalizeMailAddress(raw);
  return EXACT_ADDRESS.test(address) ? address : null;
}

/**
 * The file text for a list of addresses. Every entry must be an exact address, so a wildcard is never
 * written. An empty list is valid and denies every send.
 */
export function renderAllowedRecipientsFile(addresses: readonly string[]): string {
  const exact = addresses.map(address => {
    const checked = exactRecipientAddress(address);
    if (checked === null) {
      throw new Error(`Refusing to write ${JSON.stringify(address)}: it is not an exact address.`);
    }
    return checked;
  });
  return [
    `db_location = "${MAIL_INDEX_DB_LOCATION}"`,
    `allowed_recipients = [${exact.map(address => `"${address}"`).join(', ')}]`,
    '',
  ].join('\n');
}

/** The hash the sidecar's wrapper records for a file's bytes. Both sides use SHA-256 in lowercase hex. */
export function allowedRecipientsFileHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Replaces the file in one step: the new text is written and flushed to a temporary sibling, then renamed
 * over the old file. A refused list leaves the existing file untouched. Returns the hash of the new text.
 *
 * The sidecar runs as another user, so the file is world-readable. It holds only addresses.
 */
export async function writeAllowedRecipientsFile({
  path,
  addresses,
}: {
  path: string;
  addresses: readonly string[];
}): Promise<string> {
  const text = renderAllowedRecipientsFile(addresses);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o644);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return allowedRecipientsFileHash(text);
}

/**
 * The addresses the file allows. A missing, unreadable or unfamiliar file allows nothing, so a damaged
 * file stops sends instead of opening them.
 */
export async function readAllowedRecipientsFile({ path }: { path: string }): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const shape = FILE_SHAPE.exec(text);
  if (shape?.[1] !== MAIL_INDEX_DB_LOCATION) {
    return [];
  }
  const inner = shape[2] ?? '';
  if (inner === '') {
    return [];
  }
  const addresses: string[] = [];
  for (const item of inner.split(', ')) {
    const quoted = /^"([^"]*)"$/.exec(item);
    const value = quoted?.[1];
    if (value === undefined || exactRecipientAddress(value) !== value) {
      return [];
    }
    addresses.push(value);
  }
  return addresses;
}

/**
 * Writes an empty list when no readable file exists yet, so the sidecar has a config to start from. An existing
 * file is left alone. Returns true when it wrote the file.
 */
export async function ensureAllowedRecipientsFile({ path }: { path: string }): Promise<boolean> {
  try {
    await readFile(path);
    return false;
  } catch {
    await writeAllowedRecipientsFile({ path, addresses: [] });
    return true;
  }
}

/** Each add waits for the one before it, so two approvals at once cannot drop each other's address. */
let policyChain: Promise<unknown> = Promise.resolve();

/** Adds exact addresses to the file, keeping the others. Returns the hash of the file as written. */
export async function addAllowedRecipients({
  path,
  addresses,
}: {
  path: string;
  addresses: readonly string[];
}): Promise<string> {
  const added = addresses.map(address => {
    const checked = exactRecipientAddress(address);
    if (checked === null) {
      throw new Error(`Refusing to add ${JSON.stringify(address)}: it is not an exact address.`);
    }
    return checked;
  });
  const next = policyChain.then(async () => {
    const current = await readAllowedRecipientsFile({ path });
    const merged = [...current, ...added.filter(address => !current.includes(address))];
    return writeAllowedRecipientsFile({ path, addresses: [...new Set(merged)] });
  });
  policyChain = next.catch(() => undefined);
  return next;
}

/**
 * How long a send waits for the sidecar to load a new list before it gives up and keeps the draft. It covers a
 * full sidecar restart: the wrapper checks the list every 2 seconds and gives the old server 5 seconds to stop.
 */
export const SIDECAR_LOAD_TIMEOUT_MS = 45_000;

/**
 * Waits until the sidecar's status file names `hash`. The file is written by the sidecar's wrapper after
 * each start. Returns false on timeout; a missing status file keeps waiting, since the sidecar may be starting.
 */
export async function waitForSidecarLoadedHash({
  statusPath,
  hash,
  timeoutMs = SIDECAR_LOAD_TIMEOUT_MS,
  pollMs = 500,
}: {
  statusPath: string;
  hash: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let loaded = await sidecarLoadedHash(statusPath);
  while (loaded !== hash && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    loaded = await sidecarLoadedHash(statusPath);
  }
  return loaded === hash;
}

/**
 * Waits until the sidecar runs the list the file holds right now. Returns false when there is no readable file,
 * since then nothing can be confirmed loaded.
 */
export async function waitForCurrentSidecarList({
  path,
  statusPath,
  timeoutMs = SIDECAR_LOAD_TIMEOUT_MS,
}: {
  path: string;
  statusPath: string;
  timeoutMs?: number;
}): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return false;
  }
  return waitForSidecarLoadedHash({ statusPath, hash: allowedRecipientsFileHash(text), timeoutMs });
}

async function sidecarLoadedHash(statusPath: string): Promise<string | null> {
  try {
    return (await readFile(statusPath, 'utf8')).trim();
  } catch {
    return null;
  }
}
