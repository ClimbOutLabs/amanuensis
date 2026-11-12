import { isRecord } from '../../util/records';
import type { ListedMailbox } from './mailboxNames';

function emailsOf(value: unknown): unknown[] | undefined {
  const emails = isRecord(value) ? value['emails'] : undefined;
  return Array.isArray(emails) ? emails : undefined;
}

/** Every text block of a tool result, parsed as JSON. A block that is not JSON is left out. */
function parsedTextBlocks(result: Record<string, unknown>): unknown[] {
  const content = result['content'];
  if (!Array.isArray(content)) {
    return [];
  }
  const parsed: unknown[] = [];
  for (const block of content) {
    const text = isRecord(block) ? block['text'] : undefined;
    if (typeof text !== 'string') {
      continue;
    }
    try {
      parsed.push(JSON.parse(text));
    } catch {
      // Plain text carries no structured data.
    }
  }
  return parsed;
}

/** The metadata page's emails, read from the tool's structured result or its JSON text. Anything else reads as none. */
export function emailsOfResult(result: unknown): unknown[] {
  if (!isRecord(result)) {
    return [];
  }
  const structured = emailsOf(result['structuredContent']);
  if (structured !== undefined) {
    return structured;
  }
  const [first] = parsedTextBlocks(result);
  return emailsOf(first) ?? [];
}

/**
 * The entries of a list the sidecar returns. The list may come as a structured `result` array, or as one
 * JSON text block per entry or for the whole list.
 */
function listedEntries(result: Record<string, unknown>): unknown[] {
  const structured = result['structuredContent'];
  const listed: unknown = isRecord(structured) ? structured['result'] : undefined;
  return Array.isArray(listed)
    ? listed
    : parsedTextBlocks(result).flatMap((block): unknown[] => (Array.isArray(block) ? block : [block]));
}

/** The account names in the sidecar's account list. Each name appears once, in the order given. */
export function accountNamesOfResult(result: unknown): string[] {
  if (!isRecord(result)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of listedEntries(result)) {
    const name = isRecord(entry) ? entry['account_name'] : undefined;
    if (typeof name === 'string' && name.length > 0 && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/** The folders in the sidecar's mailbox list. An entry with no name is left out; a missing delimiter or flag list reads as none. */
export function mailboxesOfResult(result: unknown): ListedMailbox[] {
  if (!isRecord(result)) {
    return [];
  }
  const mailboxes: ListedMailbox[] = [];
  for (const entry of listedEntries(result)) {
    const name = isRecord(entry) ? entry['name'] : undefined;
    if (!isRecord(entry) || typeof name !== 'string' || name.length === 0) {
      continue;
    }
    const delimiter = typeof entry['delimiter'] === 'string' ? entry['delimiter'] : '';
    const flags = Array.isArray(entry['flags'])
      ? entry['flags'].filter((flag): flag is string => typeof flag === 'string')
      : [];
    mailboxes.push({ name, delimiter, flags });
  }
  return mailboxes;
}
