/**
 * Tracked open items: the requests and commitments a person still has open, kept apart from the
 * diary. The diary stays the complete evidence trail; this file is the state folded from it.
 *
 * One append-only plain file per owner, `items.md`, lives with the memory files and reads end to
 * end as plain text. Every change is one event with a stable id, so a retried turn never applies
 * twice. The host folds the events into the outstanding list before diary recall is budgeted, so
 * tracked state never competes with diary entries for tokens.
 *
 * The model flags a possible request or completion during the turn-end passes it already makes,
 * naming the owner and the action in plain words and citing the exact passage. Nothing here
 * trusts the flag: the host verifies the citation against the named source and applies the
 * evidence bar before an event is appended.
 */
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'winston';
import type { TurnToolResult } from './memoryNotesSummarize';
import { uuidv5 } from './uuidv5';

/** The items file's name inside the folder that holds the memory files. */
export const ITEMS_FILE = 'items.md';

/** Fixed namespace for the event and item ids this module mints. */
const ITEM_NAMESPACE = '7c1e5a42-3f6d-5b8e-9a2c-4d5e6f708192';

/** What one flag from a turn-end model pass claims. */
export type ItemFlagKind = 'request' | 'completion' | 'partial' | 'correction';

/** What a correction says, in the person's own terms. */
export type ItemCorrection = 'already_done' | 'not_theirs' | 'mine' | 'drop' | 'reopen';

/**
 * One change a model pass flagged for the item list. The flag is a claim, not a fact: the host
 * verifies its citation and applies the evidence bar before anything is recorded.
 */
export interface ItemFlag {
  kind: ItemFlagKind;
  /** Number of an entry in the list the pass was shown, when the flag is about an existing item. */
  item?: number | undefined;
  /** Number of the tool result the citation came from, on the note pass. Absent: the words are the person's or the reply's. */
  result?: number | undefined;
  /** Who the thing belongs to, in plain words: "the person" for the person themselves, else a name. */
  owner: string;
  /** The thing to do, in plain words. */
  action: string;
  /** The exact passage the flag came from, copied word for word. */
  citation: string;
  /** Note pass only: the source was sent to the person, not merely read by them. */
  addressedToPerson?: boolean | undefined;
  /** Note pass only: the request belongs to something the person is responsible for. */
  tiedToRole?: boolean | undefined;
  /** The day it is due, YYYY-MM-DD, when the passage states one. */
  due?: string | undefined;
  /** What a correction says. */
  correction?: ItemCorrection | undefined;
}

/** The kinds of event the log holds. */
export type ItemEventKind =
  'opened' | 'surfaced' | 'noted' | 'completion_noted' | 'partial_noted' | 'corrected' | 'closed' | 'reopened';

/** Why an item closed. */
export type ItemCloseReason = 'completed' | 'dropped' | 'not_theirs';

/** One recorded change to one item. The file is a list of these, in the order they happened. */
export interface ItemEvent {
  eventId: string;
  /** ISO instant the turn that caused the event finished. */
  at: string;
  kind: ItemEventKind;
  itemId: string;
  action?: string | undefined;
  owner?: string | undefined;
  due?: string | undefined;
  /** Where the passage came from: 'person', 'reply', or a tool result's source such as 'email'. */
  source?: string | undefined;
  citation?: string | undefined;
  /** What was done so far, what could not be matched, or what the correction said. */
  note?: string | undefined;
  closeReason?: ItemCloseReason | undefined;
}

/** One item as the fold leaves it. */
export interface TrackedItem {
  id: string;
  state: 'open' | 'surfaced' | 'closed';
  closeReason?: ItemCloseReason | undefined;
  owner: string;
  action: string;
  due?: string | undefined;
  /** The passage the item was opened from; a repeat of the same request matches on it. */
  citation: string;
  source: string;
  openedAt: string;
  /** Work recorded as done while the item stays open, oldest first. */
  partialNotes: string[];
  /** Completions that could not be matched to this item for sure, oldest first. */
  unconfirmedCompletions: string[];
  /** Later copies or chasers seen for this item while it stood open. */
  evidenceCount: number;
}

/** Longest flag field kept; a longer one is not a plain-words name or action. */
const FLAG_OWNER_MAX_CHARACTERS = 120;
const FLAG_ACTION_MAX_CHARACTERS = 240;
const FLAG_CITATION_MAX_CHARACTERS = 500;

/** A citation shorter than this, once flattened, is too little to verify against a source. */
const CITATION_MIN_CHARACTERS = 10;

const ITEM_FLAG_KINDS: readonly ItemFlagKind[] = ['request', 'completion', 'partial', 'correction'];
const ITEM_CORRECTIONS: readonly ItemCorrection[] = ['already_done', 'not_theirs', 'mine', 'drop', 'reopen'];

function isItemFlagKind(value: unknown): value is ItemFlagKind {
  return ITEM_FLAG_KINDS.some(kind => kind === value);
}

function isItemCorrection(value: unknown): value is ItemCorrection {
  return ITEM_CORRECTIONS.some(correction => correction === value);
}
const DUE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flagText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' || text.length > max ? undefined : text;
}

function flagNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function flagBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * The item flags in a model pass's reply, read loosely like the profile list: a missing or
 * malformed list, or a malformed entry, means only that no flag is taken from it. It never makes
 * the facts or findings of the same reply unreadable. The caller hands over the reply's JSON,
 * already pulled out of the reply text by the pass that read it.
 */
export function parseItemFlags(parsed: unknown): ItemFlag[] {
  if (!isRecord(parsed) || !Array.isArray(parsed['items'])) {
    return [];
  }
  const flags: ItemFlag[] = [];
  for (const raw of parsed['items']) {
    if (!isRecord(raw)) {
      continue;
    }
    const kind = raw['kind'];
    const owner = flagText(raw['owner'], FLAG_OWNER_MAX_CHARACTERS);
    const action = flagText(raw['action'], FLAG_ACTION_MAX_CHARACTERS);
    const citation = flagText(raw['citation'], FLAG_CITATION_MAX_CHARACTERS);
    if (!isItemFlagKind(kind) || owner === undefined || action === undefined) {
      continue;
    }
    if (citation === undefined) {
      continue;
    }
    const correction = raw['correction'];
    const due = raw['due'];
    flags.push({
      kind,
      item: flagNumber(raw['item']),
      result: flagNumber(raw['result']),
      owner,
      action,
      citation,
      addressedToPerson: flagBool(raw['addressedToPerson']),
      tiedToRole: flagBool(raw['tiedToRole']),
      due: typeof due === 'string' && DUE_DATE.test(due) ? due : undefined,
      correction: isItemCorrection(correction) ? correction : undefined,
    });
  }
  return flags;
}

/** Text compared by its words alone: case, accents, spacing and punctuation flattened away. */
export function itemComparisonText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Whether the citation appears in the source text, compared by words so wrapping and punctuation never decide it. */
export function citationVerifies({ citation, sourceText }: { citation: string; sourceText: string }): boolean {
  const needle = itemComparisonText(citation);
  if (needle.length < CITATION_MIN_CHARACTERS) {
    return false;
  }
  return itemComparisonText(sourceText).includes(needle);
}

/** Whether two citations are the same passage: equal once flattened, or one inside the other. */
function sameCitation({ first, second }: { first: string; second: string }): boolean {
  const left = itemComparisonText(first);
  const right = itemComparisonText(second);
  if (left.length < CITATION_MIN_CHARACTERS || right.length < CITATION_MIN_CHARACTERS) {
    return false;
  }
  return left === right || left.includes(right) || right.includes(left);
}

/** The content words two texts share that are long enough, or numeric enough, to tie a passage to an item. */
function sharesAnchor({ first, second }: { first: string; second: string }): boolean {
  const wordsOf = (text: string): Set<string> =>
    new Set(
      itemComparisonText(text)
        .split(' ')
        .filter(word => word.length >= 4 || /^\d{2,}$/.test(word)),
    );
  const left = wordsOf(first);
  for (const word of wordsOf(second)) {
    if (left.has(word)) {
      return true;
    }
  }
  return false;
}

/** Words that say a thing must still be handed over: sent, filed, posted, returned. */
const DELIVER_WORDS: ReadonlySet<string> = new Set([
  'submit',
  'submits',
  'submitted',
  'send',
  'sends',
  'sent',
  'post',
  'posts',
  'posted',
  'mail',
  'mailed',
  'file',
  'files',
  'filed',
  'return',
  'returns',
  'returned',
  'upload',
  'uploaded',
  'deliver',
  'delivers',
  'delivered',
  'hand',
  'handed',
]);

/** Words that say a thing was made ready, which is not the same as handing it over. */
const PREPARE_WORDS: ReadonlySet<string> = new Set([
  'fill',
  'fills',
  'filled',
  'filling',
  'complete',
  'completes',
  'completed',
  'completing',
  'finish',
  'finished',
  'draft',
  'drafted',
  'prepare',
  'prepared',
  'sign',
  'signs',
  'signed',
]);

function holdsWord(text: string, words: ReadonlySet<string>): boolean {
  return itemComparisonText(text)
    .split(' ')
    .some(word => words.has(word));
}

/** Header shapes that mark a message as bulk sent, whatever its wording says. */
const BULK_MARKERS = /list-unsubscribe|list-id:|precedence:\s*bulk/i;

/** The address line of a message, when the text carries one. */
const TO_LINE = /^to:\s*(.+)$/im;

/** Whether the flag's owner names the person themselves rather than somebody else. */
export function namesThePerson({ owner, personName }: { owner: string; personName: string | undefined }): boolean {
  const named = itemComparisonText(owner);
  if (named === '') {
    return false;
  }
  if (named === 'the person' || named === 'you' || named === 'me' || named === 'i' || named === 'the user') {
    return true;
  }
  const own = personName === undefined ? '' : itemComparisonText(personName);
  if (own === '') {
    return false;
  }
  return named === own || named.includes(own) || own.includes(named);
}

/** The file's path inside the folder that holds the memory files. */
export function itemsFilePath(dir: string): string {
  return path.join(dir, ITEMS_FILE);
}

const EVENT_HEADER = /^## (\S+) · (\S+) · (\w+) · (\S+)$/;

/** One event as it stands in the file: a header line, then one field per line. */
export function formatItemEvent(event: ItemEvent): string {
  const lines = [`## ${event.at} · ${event.eventId} · ${event.kind} · ${event.itemId}`];
  const field = (name: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') {
      lines.push(`${name}: ${value.replace(/\s+/g, ' ').trim()}`);
    }
  };
  field('Action', event.action);
  field('Owner', event.owner);
  field('Due', event.due);
  field('Source', event.source);
  field('Closed as', event.closeReason);
  field('Note', event.note);
  field('Said', event.citation);
  return `${lines.join('\n')}\n\n`;
}

const EVENT_KINDS: readonly ItemEventKind[] = [
  'opened',
  'surfaced',
  'noted',
  'completion_noted',
  'partial_noted',
  'corrected',
  'closed',
  'reopened',
];
const CLOSE_REASONS: readonly ItemCloseReason[] = ['completed', 'dropped', 'not_theirs'];

function isItemEventKind(value: unknown): value is ItemEventKind {
  return EVENT_KINDS.some(kind => kind === value);
}

function isItemCloseReason(value: unknown): value is ItemCloseReason {
  return CLOSE_REASONS.some(reason => reason === value);
}

/** The events a file holds. A line that cannot be read is skipped, never fatal: the diary is the evidence trail. */
export function parseItemLog(content: string): ItemEvent[] {
  const events: ItemEvent[] = [];
  let current: ItemEvent | undefined;
  const flush = (): void => {
    if (current !== undefined) {
      events.push(current);
      current = undefined;
    }
  };
  for (const line of content.split('\n')) {
    const header = EVENT_HEADER.exec(line);
    if (header !== null) {
      flush();
      const [, at, eventId, kind, itemId] = header;
      if (at !== undefined && eventId !== undefined && isItemEventKind(kind) && itemId !== undefined) {
        current = { at, eventId, kind, itemId };
      }
      continue;
    }
    if (current === undefined) {
      continue;
    }
    const split = line.indexOf(': ');
    if (split === -1) {
      continue;
    }
    const name = line.slice(0, split);
    const value = line.slice(split + 2);
    switch (name) {
      case 'Action':
        current.action = value;
        break;
      case 'Owner':
        current.owner = value;
        break;
      case 'Due':
        current.due = DUE_DATE.test(value) ? value : undefined;
        break;
      case 'Source':
        current.source = value;
        break;
      case 'Closed as':
        current.closeReason = isItemCloseReason(value) ? value : undefined;
        break;
      case 'Note':
        current.note = value;
        break;
      case 'Said':
        current.citation = value;
        break;
      default:
        break;
    }
  }
  flush();
  return events;
}

/** The items the events leave behind, in the order they were first opened or surfaced. A retried event id applies once. */
export function foldItemEvents(events: readonly ItemEvent[]): TrackedItem[] {
  const seen = new Set<string>();
  const byId = new Map<string, TrackedItem>();
  const order: TrackedItem[] = [];
  const ensure = (event: ItemEvent): TrackedItem => {
    const existing = byId.get(event.itemId);
    if (existing !== undefined) {
      return existing;
    }
    const item: TrackedItem = {
      id: event.itemId,
      state: 'surfaced',
      owner: event.owner ?? 'the person',
      action: event.action ?? '',
      due: event.due,
      citation: event.citation ?? '',
      source: event.source ?? 'person',
      openedAt: event.at,
      partialNotes: [],
      unconfirmedCompletions: [],
      evidenceCount: 0,
    };
    byId.set(event.itemId, item);
    order.push(item);
    return item;
  };
  for (const event of events) {
    if (seen.has(event.eventId)) {
      continue;
    }
    seen.add(event.eventId);
    const item = ensure(event);
    switch (event.kind) {
      case 'opened':
        item.state = 'open';
        item.closeReason = undefined;
        if (event.action !== undefined) {
          item.action = event.action;
        }
        if (event.owner !== undefined) {
          item.owner = event.owner;
        }
        if (event.due !== undefined) {
          item.due = event.due;
        }
        if (event.citation !== undefined) {
          item.citation = event.citation;
        }
        if (event.source !== undefined) {
          item.source = event.source;
        }
        break;
      case 'surfaced':
        // A below-bar copy never demotes an item that already tracks or already closed.
        if (item.state === 'surfaced' && item.action === '') {
          if (event.action !== undefined) {
            item.action = event.action;
          }
          if (event.citation !== undefined) {
            item.citation = event.citation;
          }
        }
        break;
      case 'noted':
        if (item.state === 'open') {
          item.evidenceCount += 1;
        }
        break;
      case 'completion_noted':
        if (item.state === 'open' && event.note !== undefined) {
          item.unconfirmedCompletions.push(event.note);
        }
        break;
      case 'partial_noted':
        if (item.state === 'open' && event.note !== undefined) {
          item.partialNotes.push(event.note);
        }
        break;
      case 'corrected':
        if (event.action !== undefined && event.action !== '') {
          item.action = event.action;
        }
        break;
      case 'closed':
        item.state = 'closed';
        item.closeReason = event.closeReason ?? 'completed';
        break;
      case 'reopened':
        item.state = 'open';
        item.closeReason = undefined;
        break;
    }
  }
  return order;
}

/** Appends in this process are serialized, so two turns ending together never interleave lines. */
let appendChain: Promise<void> = Promise.resolve();

/**
 * Appends events to the owner's items file. An event whose id is already in the file is not
 * appended again, so a turn whose retain is resubmitted records each change once. Never throws:
 * a failed append is logged and the diary still holds the evidence.
 */
export async function appendItemEvents({
  dir,
  events,
  logger,
}: {
  dir: string;
  events: readonly ItemEvent[];
  logger: Logger;
}): Promise<void> {
  if (events.length === 0) {
    return;
  }
  const run = async (): Promise<void> => {
    try {
      await mkdir(dir, { recursive: true });
      let existing = '';
      try {
        existing = await readFile(itemsFilePath(dir), 'utf8');
      } catch {
        existing = '';
      }
      const held = new Set(parseItemLog(existing).map(event => event.eventId));
      const fresh = events.filter(event => !held.has(event.eventId));
      if (fresh.length === 0) {
        return;
      }
      await appendFile(itemsFilePath(dir), fresh.map(formatItemEvent).join(''), 'utf8');
    } catch (error) {
      logger.warn('Item events could not be saved', extractErrorLogFields(error));
    }
  };
  appendChain = appendChain.then(run, run);
  await appendChain;
}

/** The events in the owner's items file; none when there is no file or it cannot be read. */
export async function readItemEvents({ dir, logger }: { dir: string; logger: Logger }): Promise<ItemEvent[]> {
  try {
    return parseItemLog(await readFile(itemsFilePath(dir), 'utf8'));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    logger.debug('The items file could not be read; no items are tracked this turn', extractErrorLogFields(error));
    return [];
  }
}

/** One entry of the numbered list the model passes are shown: its number and the item it names. */
export interface ItemListEntry {
  number: number;
  item: TrackedItem;
}

/** Bounds on the list shown to a model pass, so a long history cannot crowd out the turn itself. */
const PROMPT_OPEN_MAX = 30;
const PROMPT_SURFACED_MAX = 10;
const PROMPT_CLOSED_MAX = 5;

/**
 * The numbered list of items a model pass is shown: open items first, then ones mentioned once,
 * then the most recently closed, so a completion, a correction or a reopening can name its item
 * by number. The same list goes to both passes of a turn, so a number means the same item in each.
 */
export function itemListForPrompt(items: readonly TrackedItem[]): { lines: string[]; entries: ItemListEntry[] } {
  const open = items.filter(item => item.state === 'open').slice(0, PROMPT_OPEN_MAX);
  const surfaced = items.filter(item => item.state === 'surfaced').slice(0, PROMPT_SURFACED_MAX);
  const closed = items
    .filter(item => item.state === 'closed')
    .slice(-PROMPT_CLOSED_MAX)
    .reverse();
  const picked = [...open, ...surfaced, ...closed];
  const entries = picked.map((item, index) => ({ number: index + 1, item }));
  const lines = entries.map(({ number, item }) => {
    const due = item.due === undefined ? '' : `, due ${item.due}`;
    switch (item.state) {
      case 'open': {
        const partial =
          item.partialNotes.length === 0
            ? ''
            : ` Partly done: ${item.partialNotes[item.partialNotes.length - 1] ?? ''}.`;
        const unsure =
          item.unconfirmedCompletions.length === 0
            ? ''
            : ' A later message may have finished this, but it could not be matched for sure.';
        return `${String(number)}. Still to do: ${item.action} (owner: ${item.owner}${due}).${partial}${unsure}`;
      }
      case 'surfaced':
        return `${String(number)}. Mentioned once, not tracked: ${item.action} (owner: ${item.owner}${due}).`;
      case 'closed':
        return `${String(number)}. Closed: ${item.action} (owner: ${item.owner}).`;
    }
  });
  return { lines, entries };
}

/** Most open items the block ahead of the diary shows; the rest are counted, and the file holds them all. */
const BLOCK_MAX_ITEMS = 12;

/**
 * The outstanding list as its own small block, supplied ahead of the diary block so tracked state
 * never competes with diary entries for tokens. Only open items appear: a mentioned-once item
 * surfaces in its own conversation, not here. When more are open than fit, the block says how
 * many remain and where the whole list lives. Undefined when nothing is open.
 */
export function formatItemsBlock({
  items,
  today,
}: {
  items: readonly TrackedItem[];
  today: string;
}): string | undefined {
  const open = items.filter(item => item.state === 'open');
  if (open.length === 0) {
    return undefined;
  }
  const lines = [
    '<aman-items>',
    'Open items tracked for the person, worked out by the host from what was asked and what was finished. This list is current even when the diary below is cut short. An item leaves this list only when finishing it is established, never because its date passed.',
  ];
  open.slice(0, BLOCK_MAX_ITEMS).forEach((item, index) => {
    const due =
      item.due === undefined ? '' : item.due < today ? ` Due ${item.due}, which has passed.` : ` Due ${item.due}.`;
    const partial =
      item.partialNotes.length === 0 ? '' : ` Partly done: ${item.partialNotes[item.partialNotes.length - 1] ?? ''}.`;
    const unsure =
      item.unconfirmedCompletions.length === 0
        ? ''
        : ' A later message may have finished this, but Aman could not tell for sure, so it is still counted as open. Ask about it if it matters.';
    lines.push(`${String(index + 1)}. ${item.action}.${due}${partial}${unsure}`);
  });
  if (open.length > BLOCK_MAX_ITEMS) {
    lines.push(
      `${String(open.length - BLOCK_MAX_ITEMS)} more open items are not shown here. The whole list is in the items file with the memory files.`,
    );
  }
  lines.push('</aman-items>');
  return lines.join('\n');
}

/** The sources a flag's citation can be checked against, exactly as the passes saw them. */
export interface ItemFlagSources {
  userText: string;
  assistantText: string;
  /** The tool results as the note pass numbered them. */
  results: readonly TurnToolResult[];
}

/** The deterministic event id for one flag of one turn: a resubmitted turn mints the same ids. */
export function itemEventId({
  sessionId,
  turnId,
  pass,
  index,
  part,
}: {
  sessionId: string;
  turnId: string;
  pass: string;
  index: number;
  /** Set when one flag earns one event per item it touches, so each keeps its own id. */
  part?: string | undefined;
}): string {
  const name = `${sessionId}/${turnId}/items/${pass}/${String(index)}${part === undefined ? '' : `/${part}`}`;
  return `evt-${uuidv5({ name, namespace: ITEM_NAMESPACE }).slice(0, 12)}`;
}

/** The stable item id minted from the event that first named the item. */
function itemIdFor(eventId: string): string {
  return `item-${uuidv5({ name: `item/${eventId}`, namespace: ITEM_NAMESPACE }).slice(0, 8)}`;
}

/**
 * The events one turn's flags earn, judged against the folded state the turn started from and the
 * sources the flags cite. This is the evidence bar: a flag changes the list only when its
 * citation verifies against the source it names and the passage clears the bar for its kind.
 * Pure: it reads no files and appends nothing, so the caller decides when to write.
 */
export function eventsForItemFlags(params: {
  flags: readonly ItemFlag[];
  pass: 'person' | 'notes';
  sessionId: string;
  turnId: string;
  at: string;
  items: readonly TrackedItem[];
  entries: readonly ItemListEntry[];
  sources: ItemFlagSources;
  personName: string | undefined;
}): ItemEvent[] {
  const events: ItemEvent[] = [];
  const namedItem = (flag: ItemFlag): TrackedItem | undefined =>
    flag.item === undefined ? undefined : params.entries.find(entry => entry.number === flag.item)?.item;
  /** Open items a passage could be about: the ones sharing a name, number or long word with it. */
  const candidatesFor = (flag: ItemFlag): TrackedItem[] =>
    params.items.filter(
      item =>
        item.state === 'open' &&
        sharesAnchor({ first: `${flag.action} ${flag.citation}`, second: `${item.action} ${item.citation}` }),
    );
  const base = (index: number, part?: string) => ({
    eventId: itemEventId({ sessionId: params.sessionId, turnId: params.turnId, pass: params.pass, index, part }),
    at: params.at,
  });

  const requestEvents = (flag: ItemFlag, index: number): void => {
    // A request that names an existing item, or repeats its passage, is evidence about that item.
    const named = namedItem(flag);
    const repeated = params.items.find(item => sameCitation({ first: item.citation, second: flag.citation }));
    const target = named ?? repeated;
    if (target !== undefined) {
      if (
        target.state === 'closed' &&
        citationVerifies({ citation: flag.citation, sourceText: params.sources.userText })
      ) {
        // The person states the same need again in their own words: the item is live again.
        events.push({ ...base(index), kind: 'reopened', itemId: target.id });
      } else if (target.state === 'open') {
        events.push({
          ...base(index),
          kind: 'noted',
          itemId: target.id,
          citation: flag.citation,
          note: 'The same request was seen again.',
        });
      }
      return;
    }
    const eventId = itemEventId({ sessionId: params.sessionId, turnId: params.turnId, pass: params.pass, index });
    const itemId = itemIdFor(eventId);
    const opened: ItemEvent = {
      eventId,
      at: params.at,
      kind: 'opened',
      itemId,
      action: flag.action,
      owner: flag.owner,
      due: flag.due,
      citation: flag.citation,
    };
    if (flag.result !== undefined) {
      const result = params.sources.results[flag.result - 1];
      if (result === undefined || !citationVerifies({ citation: flag.citation, sourceText: result.text })) {
        return;
      }
      // A request that belongs to somebody else is not the person's to track or to pick up.
      if (!namesThePerson({ owner: flag.owner, personName: params.personName })) {
        return;
      }
      // Read content must clear the bar: the person's own name on it, a passage addressed to
      // them or tied to their responsibility, and no bulk sending without that tie.
      const bulk = BULK_MARKERS.test(result.text);
      const tied = flag.tiedToRole === true;
      const toLine = TO_LINE.exec(result.text)?.[1];
      const addressedByName =
        toLine === undefined ||
        params.personName === undefined ||
        itemComparisonText(toLine).includes(itemComparisonText(params.personName));
      const clears = (flag.addressedToPerson === true || tied) && addressedByName && (!bulk || tied);
      if (clears) {
        events.push({ ...opened, source: result.source });
      } else if (!bulk || tied) {
        // Below the bar it is recorded once, untracked, so the person's word can pick it up later.
        events.push({ ...opened, kind: 'surfaced', source: result.source });
      }
      return;
    }
    if (citationVerifies({ citation: flag.citation, sourceText: params.sources.userText })) {
      // The person's own word is enough, when the thing is theirs.
      if (namesThePerson({ owner: flag.owner, personName: params.personName })) {
        events.push({ ...opened, source: 'person' });
      }
      return;
    }
    // A request that cites only the reply, or nothing that verifies, opens nothing.
  };

  const completionEvents = (flag: ItemFlag, index: number, partialOnly: boolean): void => {
    const named = namedItem(flag);
    const candidates = named !== undefined ? [named] : candidatesFor(flag);
    const open = candidates.filter(item => item.state === 'open');
    if (open.length !== 1) {
      // Ambiguous or unplaceable: recorded against every candidate it could mean, closing none.
      for (const item of open) {
        events.push({
          ...base(index, item.id),
          kind: 'completion_noted',
          itemId: item.id,
          citation: flag.citation,
          note: flag.action,
        });
      }
      return;
    }
    const [item] = open;
    if (item === undefined) {
      return;
    }
    const cited =
      citationVerifies({ citation: flag.citation, sourceText: params.sources.userText }) ||
      (flag.result !== undefined &&
        params.sources.results[flag.result - 1] !== undefined &&
        citationVerifies({
          citation: flag.citation,
          sourceText: params.sources.results[flag.result - 1]?.text ?? '',
        })) ||
      citationVerifies({ citation: flag.citation, sourceText: params.sources.assistantText });
    const aboutItem = sharesAnchor({
      first: `${flag.action} ${flag.citation}`,
      second: `${item.action} ${item.citation}`,
    });
    if (!cited || !aboutItem) {
      events.push({
        ...base(index),
        kind: 'completion_noted',
        itemId: item.id,
        citation: flag.citation,
        note: flag.action,
      });
      return;
    }
    // Filling in a form satisfies a request to fill it in. Against a request to hand the thing
    // over, work that only made it ready is partial, however the flag was worded.
    const onlyPrepared =
      holdsWord(item.action, DELIVER_WORDS) &&
      holdsWord(`${flag.action} ${flag.citation}`, PREPARE_WORDS) &&
      !holdsWord(`${flag.action} ${flag.citation}`, DELIVER_WORDS);
    if (partialOnly || onlyPrepared) {
      events.push({
        ...base(index),
        kind: 'partial_noted',
        itemId: item.id,
        citation: flag.citation,
        note: flag.action,
      });
      return;
    }
    events.push({
      ...base(index),
      kind: 'closed',
      itemId: item.id,
      citation: flag.citation,
      closeReason: 'completed',
    });
  };

  const correctionEvents = (flag: ItemFlag, index: number): void => {
    // A correction is the person's own statement; one that does not cite their words is not theirs.
    if (!citationVerifies({ citation: flag.citation, sourceText: params.sources.userText })) {
      return;
    }
    const named = namedItem(flag);
    const candidates =
      named !== undefined
        ? [named]
        : params.items.filter(item => sharesAnchor({ first: flag.action, second: item.action }));
    const [item] = candidates;
    if (item === undefined || candidates.length !== 1) {
      return;
    }
    switch (flag.correction) {
      case 'already_done':
        if (item.state === 'open' || item.state === 'surfaced') {
          events.push({ ...base(index), kind: 'closed', itemId: item.id, closeReason: 'completed', note: flag.action });
        }
        return;
      case 'not_theirs':
        if (item.state === 'open' || item.state === 'surfaced') {
          events.push({
            ...base(index),
            kind: 'closed',
            itemId: item.id,
            closeReason: 'not_theirs',
            note: flag.action,
          });
        }
        return;
      case 'drop':
        if (item.state === 'open' || item.state === 'surfaced') {
          events.push({ ...base(index), kind: 'closed', itemId: item.id, closeReason: 'dropped', note: flag.action });
        }
        return;
      case 'mine':
        if (item.state === 'surfaced') {
          events.push({
            ...base(index),
            kind: 'opened',
            itemId: item.id,
            action: item.action,
            owner: item.owner,
            due: item.due,
            citation: item.citation,
            source: item.source,
            note: 'The person said this one is theirs.',
          });
        } else if (item.state === 'closed') {
          events.push({ ...base(index), kind: 'reopened', itemId: item.id, note: flag.action });
        }
        return;
      case 'reopen':
        if (item.state === 'closed') {
          events.push({ ...base(index), kind: 'reopened', itemId: item.id, note: flag.action });
        }
        return;
      case undefined:
        if (item.state === 'open') {
          events.push({ ...base(index), kind: 'corrected', itemId: item.id, action: flag.action, note: flag.citation });
        }
        return;
    }
  };

  params.flags.forEach((flag, index) => {
    switch (flag.kind) {
      case 'request':
        requestEvents(flag, index);
        return;
      case 'completion':
        completionEvents(flag, index, false);
        return;
      case 'partial':
        completionEvents(flag, index, true);
        return;
      case 'correction':
        correctionEvents(flag, index);
        return;
    }
  });
  return events;
}
