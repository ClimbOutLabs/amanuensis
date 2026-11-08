import { randomUUID } from 'crypto';
import { open, readFile, rename, rm } from 'fs/promises';
import { dirname, join } from 'path';

import { exactRecipientAddress, readAllowedRecipientsFile, writeAllowedRecipientsFile } from './mailAllowedRecipients';

/**
 * The Email send lists, one per account. The sidecar enforces a single list for every account (its
 * config holds one allowed_recipients), so the server keeps each account's own list in this file and
 * writes their union to the sidecar's list file. An address approved for one account joins only that
 * account's list here; the classifier checks a send against the list of the account it goes from, so
 * being listed for one account never stands in for another. The file holds only addresses and lives
 * beside the sidecar's list file, in the same server-owned folder.
 */
const LISTS_FILE_NAME = 'allowed_recipients_by_account.json';

/** Where the per-account lists live, from the sidecar list file's path. */
export function accountRecipientListsPath(policyPath: string): string {
  return join(dirname(policyPath), LISTS_FILE_NAME);
}

/**
 * The per-account lists the file holds, keyed by account address. A missing, unreadable or damaged
 * file holds none, so a damaged file stops sends instead of opening them. Entries that are not
 * exact addresses are dropped on the way in.
 */
export async function readAccountRecipientLists({ path }: { path: string }): Promise<Map<string, string[]>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return new Map();
  }
  const lists = new Map<string, string[]>();
  for (const [account, value] of Object.entries(parsed)) {
    const checkedAccount = exactRecipientAddress(account);
    if (checkedAccount === null || !Array.isArray(value)) {
      continue;
    }
    const addresses: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') {
        continue;
      }
      const checked = exactRecipientAddress(item);
      if (checked !== null && !addresses.includes(checked)) {
        addresses.push(checked);
      }
    }
    lists.set(checkedAccount, addresses);
  }
  return lists;
}

/**
 * Replaces the lists file in one step, like the sidecar's list file: a temporary sibling is written
 * and flushed, then renamed over the old file. Every key and entry must be an exact address.
 */
export async function writeAccountRecipientLists({
  path,
  lists,
}: {
  path: string;
  lists: ReadonlyMap<string, readonly string[]>;
}): Promise<void> {
  const record: Record<string, string[]> = {};
  for (const [account, addresses] of lists) {
    const checkedAccount = exactRecipientAddress(account);
    if (checkedAccount === null) {
      throw new Error(`Refusing to write a send list for ${JSON.stringify(account)}: it is not an exact address.`);
    }
    record[checkedAccount] = addresses.map(address => {
      const checked = exactRecipientAddress(address);
      if (checked === null) {
        throw new Error(`Refusing to write ${JSON.stringify(address)}: it is not an exact address.`);
      }
      return checked;
    });
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o644);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
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

/** One account's own list; empty when the account has none. */
export async function readAccountRecipients({ path, account }: { path: string; account: string }): Promise<string[]> {
  const lists = await readAccountRecipientLists({ path });
  const checked = exactRecipientAddress(account);
  return checked === null ? [] : (lists.get(checked) ?? []);
}

/** Whether the per-account lists file is there at all; a missing file is what marks an unseeded install. */
export async function accountRecipientListsExist({ path }: { path: string }): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Every address on any account's list, each once, in account order. */
export function unionOfAccountLists(lists: ReadonlyMap<string, readonly string[]>): string[] {
  const union: string[] = [];
  for (const addresses of lists.values()) {
    for (const address of addresses) {
      if (!union.includes(address)) {
        union.push(address);
      }
    }
  }
  return union;
}

/**
 * Writes the union of the per-account lists to the sidecar's list file and returns its hash. The
 * sidecar restarts on the change, and the hash is what the server waits on before a send goes out.
 */
export async function syncSidecarListFromAccountLists({
  policyPath,
  listsPath,
}: {
  policyPath: string;
  listsPath: string;
}): Promise<string> {
  const lists = await readAccountRecipientLists({ path: listsPath });
  return writeAllowedRecipientsFile({ path: policyPath, addresses: unionOfAccountLists(lists) });
}

/** Each change waits for the one before it, so two approvals at once cannot drop each other's address. */
let listsChain: Promise<unknown> = Promise.resolve();

/**
 * Adds exact addresses to one account's list, keeping the others, and writes the new union to the
 * sidecar's list file. Returns the hash of the sidecar's list file as written.
 */
export async function addAccountRecipients({
  policyPath,
  listsPath,
  account,
  addresses,
}: {
  policyPath: string;
  listsPath: string;
  account: string;
  addresses: readonly string[];
}): Promise<string> {
  const checkedAccount = exactRecipientAddress(account);
  if (checkedAccount === null) {
    throw new Error(`Refusing to add to a send list for ${JSON.stringify(account)}: it is not an exact address.`);
  }
  const added = addresses.map(address => {
    const checked = exactRecipientAddress(address);
    if (checked === null) {
      throw new Error(`Refusing to add ${JSON.stringify(address)}: it is not an exact address.`);
    }
    return checked;
  });
  const next = listsChain.then(async () => {
    const lists = await readAccountRecipientLists({ path: listsPath });
    const current = lists.get(checkedAccount) ?? [];
    lists.set(checkedAccount, [...current, ...added.filter(address => !current.includes(address))]);
    await writeAccountRecipientLists({ path: listsPath, lists });
    return writeAllowedRecipientsFile({ path: policyPath, addresses: unionOfAccountLists(lists) });
  });
  listsChain = next.catch(() => undefined);
  return next;
}

/**
 * The first move from the one shared list: the addresses the sidecar's list already holds become
 * the one connected account's own list. Only done when exactly one account is connected, so no
 * address is ever lent to an account it was not approved under, and only when the sidecar's list
 * holds anything, so a fresh install's first fill still runs. Returns the seeded account, or null
 * when nothing was seeded.
 */
export async function seedAccountListsFromSidecarList({
  policyPath,
  listsPath,
  accounts,
}: {
  policyPath: string;
  listsPath: string;
  accounts: readonly string[];
}): Promise<string | null> {
  const [only] = accounts;
  if (accounts.length !== 1 || only === undefined) {
    return null;
  }
  const account = exactRecipientAddress(only);
  if (account === null) {
    return null;
  }
  try {
    await readFile(listsPath, 'utf8');
    return null;
  } catch {
    // No lists file yet: the seed may still apply.
  }
  const current = await readAllowedRecipientsFile({ path: policyPath });
  if (current.length === 0) {
    return null;
  }
  await writeAccountRecipientLists({ path: listsPath, lists: new Map([[account, current]]) });
  return account;
}
