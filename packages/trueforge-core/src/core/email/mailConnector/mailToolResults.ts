import { isRecord } from '../../util/records';

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
 * The account names in the sidecar's account list. The list may come as a structured `result` array, or as
 * one JSON text block per account or for the whole list. Each name appears once, in the order given.
 */
export function accountNamesOfResult(result: unknown): string[] {
  if (!isRecord(result)) {
    return [];
  }
  const structured = result['structuredContent'];
  const listed: unknown = isRecord(structured) ? structured['result'] : undefined;
  const entries: unknown[] = Array.isArray(listed)
    ? listed
    : parsedTextBlocks(result).flatMap((block): unknown[] => (Array.isArray(block) ? block : [block]));
  const names: string[] = [];
  for (const entry of entries) {
    const name = isRecord(entry) ? entry['account_name'] : undefined;
    if (typeof name === 'string' && name.length > 0 && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}
