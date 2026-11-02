import { formatCaldavWhen, type CaldavTimeValue } from '@truefoundry/trueforge-core/core/calendar/caldav/eventReview';
import { isMailSendToolName } from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import { SET_REMINDER_TOOL_NAME } from '@truefoundry/trueforge-core/core/schedules/toolContract';

import { getToolResultContent, parseMcpToolArgs, toolCallDisposition } from './toolCallParsing.js';

/**
 * The calendar and Gmail write tool names, as the step words name them (toolWords.ts). Their
 * contracts live in core (core/calendar/toolContract, core/email/gmail/toolContract); those modules
 * carry their schemas with them, which this package's typecheck cannot follow, so the names are
 * written here the way the rest of the package writes tool names.
 */
const CREATE_EVENT_TOOL_NAME = 'create_event';
const UPDATE_EVENT_TOOL_NAME = 'update_event';
const DRAFT_EMAIL_TOOL_NAME = 'draft_email';
const UPDATE_DRAFT_TOOL_NAME = 'update_draft';
const SEND_DRAFT_TOOL_NAME = 'send_draft';
/** The Email connector's draft save; its contract is MAIL_WRITE_TOOL_NAMES in the same mail contract module imported above. */
const SAVE_DRAFT_TOOL_NAME = 'save_draft';

/**
 * The slice of a message part the outcome lines read. A finished turn that left something lasting
 * behind (a reminder, a calendar change, a sent email, a saved draft) says so in one plain line
 * under the reply while agent details are off, built only from what the call itself recorded: the
 * step rows that carry these details fold away with the details, so without the line the person is
 * left trusting that the reply prose mentioned everything.
 */
export type TurnOutcomePart = {
  type: string;
  toolName?: string | undefined;
  args?: unknown;
  argsText?: string | undefined;
  result?: unknown;
  approval?: { approved?: boolean | undefined } | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => (typeof item === 'string' && item.trim() !== '' ? [item.trim()] : []));
}

/** The call's own arguments as a record: the parsed args, or the streamed args text parsed back. */
function argsRecord(part: TurnOutcomePart): Record<string, unknown> | undefined {
  if (isRecord(part.args)) return part.args;
  if (part.argsText !== undefined) {
    try {
      const parsed: unknown = JSON.parse(part.argsText);
      if (isRecord(parsed)) return parsed;
    } catch {
      // The args text is still streaming or was never JSON; there is nothing to read.
    }
  }
  return undefined;
}

/**
 * The tool result as a record, through the one decoder the step cards use, so an envelope, an MCP
 * content block and a plain JSON string all read the same way. Undefined when the result carries no
 * JSON object (plain text, or nothing yet).
 */
function resultRecord(part: TurnOutcomePart): Record<string, unknown> | undefined {
  const { data } = getToolResultContent(part.result);
  const trimmed = data.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The call that actually ran and the arguments it ran with. Connector tools can arrive wrapped in
 * the call_tool meta call; the step cards unwrap them the same way, so the outcome lines key on the
 * inner tool and its input.
 */
function effectiveCall(part: TurnOutcomePart): { name: string; args: Record<string, unknown> | undefined } {
  if (part.toolName === 'call_tool') {
    const wrapped = parseMcpToolArgs(part.argsText);
    if (wrapped.innerToolName !== undefined) {
      return { name: wrapped.innerToolName, args: isRecord(wrapped.input) ? wrapped.input : argsRecord(part) };
    }
  }
  return { name: part.toolName ?? '', args: argsRecord(part) };
}

/** A reminder from its stored summary: the words the person will be reminded with, and when it fires. */
function reminderLine(part: TurnOutcomePart): string | undefined {
  const payload = resultRecord(part);
  const set = payload !== undefined && isRecord(payload.set) ? payload.set : undefined;
  if (set === undefined) return undefined;
  const what = stringField(set, 'what');
  if (what === undefined) return undefined;
  const next = stringField(set, 'next');
  if (next !== undefined) return `Reminder set for ${next}: ${what}`;
  const when = stringField(set, 'when');
  if (when === undefined) return `Reminder set: ${what}`;
  // The stored wording for a one-time reminder starts "Once, on ..."; the line already says "set for".
  if (when.startsWith('Once, on ')) return `Reminder set for ${when.slice('Once, on '.length)}: ${what}`;
  return `Reminder set: ${what}. ${when}`;
}

/** A CalDAV time from its parts, or from a bare start string the call itself carried. */
function caldavWhen(value: unknown): string | undefined {
  if (isRecord(value)) {
    const text = stringField(value, 'value');
    if (text === undefined || typeof value.all_day !== 'boolean') return undefined;
    const tzid = stringField(value, 'tzid');
    const time: CaldavTimeValue = { value: text, all_day: value.all_day, ...(tzid !== undefined ? { tzid } : {}) };
    return formatCaldavWhen(time) ?? undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim();
    return formatCaldavWhen({ value: text, all_day: !text.includes('T') }) ?? undefined;
  }
  return undefined;
}

/**
 * A calendar change: what and when. The Google tools answer with the title and a plain when; the
 * CalDAV server answers with the event as stored; when neither answer can be read, the call itself
 * names both for a create, and an update that names neither leaves no line rather than a guess.
 */
function calendarLine({
  part,
  name,
  args,
}: {
  part: TurnOutcomePart;
  name: string;
  args: Record<string, unknown> | undefined;
}): string | undefined {
  const created = name === CREATE_EVENT_TOOL_NAME;
  const lead = created ? 'Added to your calendar' : 'Calendar event changed';
  const payload = resultRecord(part);
  if (payload !== undefined) {
    const title = stringField(payload, 'title');
    const when = stringField(payload, 'when');
    if (title !== undefined && when !== undefined) return `${lead}: ${title}, ${when}`;
    const event = isRecord(payload.event) ? payload.event : undefined;
    if (event !== undefined) {
      const summary = stringField(event, 'summary');
      const whenText = caldavWhen(event.start);
      if (summary !== undefined && whenText !== undefined) return `${lead}: ${summary}, ${whenText}`;
    }
  }
  if (args === undefined) return undefined;
  const title = stringField(args, 'title') ?? stringField(args, 'summary');
  const whenText = caldavWhen(args.start);
  if (title === undefined || whenText === undefined) return undefined;
  return `${lead}: ${title}, ${whenText}`;
}

/** Who a message was for, from the call: a list reads "a, b and c", and a long one is counted past three. */
function recipientsText(args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) return undefined;
  const recipients = stringList(args.recipients ?? args.to);
  if (recipients.length === 0) return undefined;
  if (recipients.length === 1) return recipients[0];
  if (recipients.length <= 3) {
    const last = recipients.at(-1);
    return `${recipients.slice(0, -1).join(', ')} and ${last ?? ''}`;
  }
  return `${recipients.slice(0, 3).join(', ')} and ${String(recipients.length - 3)} more`;
}

/**
 * An email outcome: a send names who it went to when the call carried the recipients (a Gmail send
 * names only its draft, so its line names the send alone), and a draft names who it is saved for.
 */
function emailLine({ name, args }: { name: string; args: Record<string, unknown> | undefined }): string | undefined {
  const who = recipientsText(args);
  if (isMailSendToolName(name) || name === SEND_DRAFT_TOOL_NAME) {
    return who !== undefined ? `Email sent to ${who}` : 'Email sent';
  }
  if (name === SAVE_DRAFT_TOOL_NAME || name === DRAFT_EMAIL_TOOL_NAME) {
    return who !== undefined ? `Draft saved for ${who}` : 'Draft saved';
  }
  if (name === UPDATE_DRAFT_TOOL_NAME) {
    return who !== undefined ? `Draft updated for ${who}` : 'Draft updated';
  }
  return undefined;
}

function outcomeLine(part: TurnOutcomePart): string | undefined {
  // A call the host says did not finish cleanly (denied, blocked, failed, never ran) left no
  // outcome to announce; the step-not-finished line already covers it. A call with no recorded
  // disposition still has to match a success shape below before any line is built.
  const disposition = toolCallDisposition(part);
  if (disposition !== undefined && disposition.disposition !== 'executed_ok') return undefined;
  if (part.result === undefined) return undefined;
  const payload = resultRecord(part);
  if (payload !== undefined && stringField(payload, 'error') !== undefined) return undefined;

  const { name, args } = effectiveCall(part);
  if (name === SET_REMINDER_TOOL_NAME) return reminderLine(part);
  if (name === CREATE_EVENT_TOOL_NAME || name === UPDATE_EVENT_TOOL_NAME) return calendarLine({ part, name, args });
  return emailLine({ name, args });
}

/**
 * One plain line per lasting outcome a finished turn left behind, in the order the calls ran.
 * Anything else (reads, searches, a call that did not run) leaves no line.
 */
export function turnOutcomeLines(parts: readonly TurnOutcomePart[]): string[] {
  const lines: string[] = [];
  for (const part of parts) {
    if (part.type !== 'tool-call') continue;
    const line = outcomeLine(part);
    if (line !== undefined) lines.push(line);
  }
  return lines;
}

type ThreadMessages = readonly { readonly id: string; readonly content: readonly TurnOutcomePart[] }[];

/**
 * One answer per thread messages list, so every message on the page asking costs one scan, not one each.
 * Keyed on the list itself: this relies on assistant-ui replacing the list whenever a message changes.
 */
const lastReminderByThread = new WeakMap<ThreadMessages, string | null>();

/** The id of the last message in the thread that set a reminder, if any. */
export function lastReminderMessageId(messages: ThreadMessages): string | undefined {
  const known = lastReminderByThread.get(messages);
  if (known !== undefined) return known ?? undefined;
  let found: string | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && turnSetReminder(message.content)) {
      found = message.id;
      break;
    }
  }
  lastReminderByThread.set(messages, found);
  return found ?? undefined;
}

/** Whether a finished turn set a reminder: the same check that writes its outcome line. */
function turnSetReminder(parts: readonly TurnOutcomePart[]): boolean {
  return parts.some(
    part =>
      part.type === 'tool-call' &&
      effectiveCall(part).name === SET_REMINDER_TOOL_NAME &&
      outcomeLine(part) !== undefined,
  );
}
