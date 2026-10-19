/**
 * The claimed-action guard. A model that failed to use a tool, or whose tool call never ran, will
 * still sometimes write "Done, I added the appointment to your calendar." Left alone, that text is
 * saved as the answer and reads as a success, and the person's next request builds on work that
 * does not exist. This module compares what a finished answer claims against what actually
 * succeeded in the same turn, so the runtime can mark the answer plainly when a claim has no
 * matching success behind it.
 *
 * The detector is deliberately narrow: past-tense, first-person or plainly passive claims about a
 * small set of action families. Plans, offers and questions ("I can add that", "Shall I send it?")
 * are not claims, and a claim with a matching successful call in the turn is left alone.
 */
import { CREATE_EVENT_TOOL_NAME, UPDATE_EVENT_TOOL_NAME } from '../calendar/toolContract';
import { SEND_DRAFT_TOOL_NAME } from '../email/gmail/toolContract';
import {
  CREATE_SCHEDULE_TOOL_NAME,
  DELETE_SCHEDULE_TOOL_NAME,
  PAUSE_SCHEDULE_TOOL_NAME,
  RESUME_SCHEDULE_TOOL_NAME,
} from '../schedules/toolContract';
import type { ContextMessage } from './AgentThread.types';
import { isInternalSystemMessage, isLLMContextMessage } from './contextUtils';

/** The note shown under an answer that claims an action nothing in the turn backs up. */
export const CLAIMED_ACTION_NOTE = 'Aman said it did this, but nothing was actually done.';

export type ActionClaimFamily = 'calendar' | 'email' | 'schedule' | 'delete' | 'save' | 'create';

/** One tool call that ran and succeeded in the turn, as the claim matcher needs to see it. */
export interface SuccessfulActionCall {
  /** The tool's own name, without any server prefix. */
  name: string;
  destructive: boolean;
}

const FIRST_PERSON = "i(?:'ve| have)?";
const JUST = '(?:just )?';

const CLAIM_PATTERNS: { family: ActionClaimFamily; pattern: RegExp }[] = [
  {
    family: 'calendar',
    pattern: new RegExp(
      `\\b${FIRST_PERSON} ${JUST}(?:added|created|scheduled|booked|set up) [^.]{0,60}?\\b(?:appointment|event|meeting|calendar)\\b`,
      'i',
    ),
  },
  {
    family: 'calendar',
    pattern:
      /(?:^|[.!]\s+)(?:the |your )?(?:appointment|event|meeting) (?:has been |was )?(?:added|created|scheduled|booked)\b/im,
  },
  {
    family: 'email',
    pattern: new RegExp(
      `\\b${FIRST_PERSON} ${JUST}(?:sent|emailed) [^.]{0,60}?\\b(?:email|mail|message|reply)\\b`,
      'i',
    ),
  },
  {
    // A second verb joined to the first claim in the same sentence: "I've saved the note and
    // sent the email." The first-person marker is further from the verb, so it gets its own,
    // longer reach within the one sentence.
    family: 'email',
    pattern: new RegExp(
      `\\b${FIRST_PERSON}\\b[^.]{0,80}?\\b(?:sent|emailed)\\b[^.]{0,40}?\\b(?:email|mail|message|reply)\\b`,
      'i',
    ),
  },
  {
    family: 'email',
    pattern: new RegExp(`\\b${FIRST_PERSON} ${JUST}(?:sent|emailed) (?:it|that)\\b`, 'i'),
  },
  {
    family: 'email',
    pattern: /(?:^|[.!]\s+)(?:the |your )?(?:email|message|reply) (?:has been |was )?sent\b/im,
  },
  {
    family: 'schedule',
    pattern: new RegExp(
      `\\b${FIRST_PERSON} ${JUST}(?:created|set up|added|scheduled) [^.]{0,60}?\\b(?:schedule|reminder)\\b`,
      'i',
    ),
  },
  {
    family: 'schedule',
    pattern: /(?:^|[.!]\s+)(?:the |your )?(?:schedule|reminder) (?:has been |was )?(?:created|set up|added)\b/im,
  },
  {
    family: 'delete',
    pattern: new RegExp(`\\b${FIRST_PERSON} ${JUST}(?:deleted|removed|cancelled|canceled)\\b`, 'i'),
  },
  {
    family: 'delete',
    pattern:
      /(?:^|[.!]\s+)(?:the |your )?(?:event|email|appointment|meeting|file|note|schedule|draft) (?:has been |was )?(?:deleted|removed|cancelled|canceled)\b/im,
  },
  {
    family: 'save',
    pattern: new RegExp(
      `\\b${FIRST_PERSON} ${JUST}(?:saved|recorded|stored) [^.]{0,40}?\\b(?:note|memory|draft|file|document|it|that)\\b`,
      'i',
    ),
  },
  {
    family: 'save',
    pattern: new RegExp(`\\b${FIRST_PERSON} ${JUST}(?:saved|recorded|stored) (?:it|that|the|your|this)\\b`, 'i'),
  },
  {
    family: 'create',
    pattern: new RegExp(`\\b${FIRST_PERSON} ${JUST}(?:added|created|booked|set up)\\b`, 'i'),
  },
];

const CLAIM_VERBS = [
  'added',
  'created',
  'scheduled',
  'booked',
  'sent',
  'emailed',
  'deleted',
  'removed',
  'cancelled',
  'canceled',
  'saved',
  'recorded',
  'stored',
  'set up',
];

/** A negation anywhere before the claim verb turns the match into a non-claim: "I haven't sent". */
const NEGATION = /(n't|\bnot\b|\bnever\b|unable to|could not|failed to)/i;

/** Where the claim verb sits inside one match, or the match length when none is found. */
function claimVerbOffset(matched: string): number {
  const lower = matched.toLowerCase();
  let verbAt = matched.length;
  for (const verb of CLAIM_VERBS) {
    const at = lower.indexOf(verb);
    if (at !== -1 && at < verbAt) {
      verbAt = at;
    }
  }
  return verbAt;
}

/** Whether the text leading into a match, up to its claim verb, negates it. */
function isNegated(input: { text: string; matchIndex: number; matched: string }): boolean {
  // The lookback stays inside the sentence the claim stands in: a "not" in the sentence
  // before ("Not sure which day you meant.") says nothing about this one.
  let sentenceStart = 0;
  for (let index = input.matchIndex - 1; index >= 0; index--) {
    const char = input.text[index];
    if (char === '.' || char === '!' || char === '?' || char === '\n') {
      sentenceStart = index + 1;
      break;
    }
  }
  const before = input.text.slice(Math.max(sentenceStart, input.matchIndex - 30), input.matchIndex);
  return NEGATION.test(before) || NEGATION.test(input.matched.slice(0, claimVerbOffset(input.matched)));
}

/**
 * The spans of a text inside double quotes: a draft the person asked for, or words quoted
 * back, are somebody's text being shown, not the answer claiming anything itself.
 */
function quotedSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let openAt: number | undefined;
  let curly = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (openAt === undefined) {
      if (char === '"' || char === '“') {
        openAt = index;
        curly = char === '“';
      }
    } else if (curly ? char === '”' : char === '"') {
      spans.push({ start: openAt, end: index });
      openAt = undefined;
    }
  }
  if (openAt !== undefined) {
    // A quote that never closes covers only the line or sentence it opened in, so a stray
    // quote (a measurement mark, a typo) cannot hide every claim that follows it.
    let end = text.length;
    for (let index = openAt + 1; index < text.length; index++) {
      const char = text[index];
      if (char === '\n' || char === '.' || char === '!' || char === '?') {
        end = index;
        break;
      }
    }
    spans.push({ start: openAt, end });
  }
  return spans;
}

/** Whether a match's claim verb falls inside a quoted span: quoted words are not a claim. */
function isQuotedClaim(input: {
  spans: { start: number; end: number }[];
  matchIndex: number;
  matched: string;
}): boolean {
  const verbAt = input.matchIndex + claimVerbOffset(input.matched);
  return input.spans.some(span => verbAt > span.start && verbAt < span.end);
}

/** The action families a finished answer claims to have done, with negated mentions left out. */
export function detectActionClaims(text: string): ActionClaimFamily[] {
  const families: ActionClaimFamily[] = [];
  const spans = quotedSpans(text);
  for (const { family, pattern } of CLAIM_PATTERNS) {
    if (families.includes(family)) {
      continue;
    }
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(global)) {
      if (
        !isNegated({ text, matchIndex: match.index, matched: match[0] }) &&
        !isQuotedClaim({ spans, matchIndex: match.index, matched: match[0] })
      ) {
        families.push(family);
        break;
      }
    }
  }
  return families;
}

const CALENDAR_TOOLS: ReadonlySet<string> = new Set([CREATE_EVENT_TOOL_NAME, UPDATE_EVENT_TOOL_NAME]);
const SCHEDULE_TOOLS: ReadonlySet<string> = new Set([
  CREATE_SCHEDULE_TOOL_NAME,
  DELETE_SCHEDULE_TOOL_NAME,
  PAUSE_SCHEDULE_TOOL_NAME,
  RESUME_SCHEDULE_TOOL_NAME,
]);

/** Whether one successful call in the turn backs up a claim of this family. */
export function claimHasMatchingSuccess(input: {
  family: ActionClaimFamily;
  successes: SuccessfulActionCall[];
}): boolean {
  const { family, successes } = input;
  switch (family) {
    case 'calendar':
      return successes.some(call => CALENDAR_TOOLS.has(call.name));
    case 'email':
      return successes.some(call => call.name === SEND_DRAFT_TOOL_NAME || call.name.includes('send'));
    case 'schedule':
      return successes.some(call => SCHEDULE_TOOLS.has(call.name));
    case 'delete':
      return successes.some(call => call.destructive || /delete|remove/.test(call.name));
    case 'save':
      return successes.some(call => /save|record|store|note|memory|draft|write/.test(call.name));
    case 'create':
      return successes.length > 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a tool result shows the call did not do the thing, so it cannot back a claim. Three
 * shapes say so: an error of any shape (the host's own envelope, or a provider's error body
 * passed through unchanged), the JSON-RPC error shape (a numeric code beside a text message),
 * and a held result: the call is only waiting for the owner's approval, so nothing has run.
 * Anything else a tool returned counts as it having worked, so the note stays rare.
 */
function toolResultDidNotRun(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) {
    return false;
  }
  if ('error' in parsed || 'held' in parsed) {
    return true;
  }
  return typeof parsed['code'] === 'number' && typeof parsed['message'] === 'string';
}

/**
 * The action calls that succeeded in the current turn: calls made after the person's latest
 * message whose tool result came back without an error, and that are actions rather than reads.
 * A result counts as not run only when it plainly shows it (an error, or a hold for approval);
 * anything else a tool returned counts as it having worked, so the note stays rare.
 */
export function successfulActionCallsThisTurn(context: readonly ContextMessage[]): SuccessfulActionCall[] {
  let boundary = -1;
  for (let index = 0; index < context.length; index++) {
    const message = context[index];
    if (
      message !== undefined &&
      isLLMContextMessage(message) &&
      message.role === 'user' &&
      !isInternalSystemMessage(message)
    ) {
      boundary = index;
    }
  }
  const callsById = new Map<string, { name: string; destructive: boolean; isAction: boolean }>();
  const failedIds = new Set<string>();
  for (let index = boundary + 1; index < context.length; index++) {
    const message = context[index];
    if (message === undefined || !isLLMContextMessage(message)) {
      continue;
    }
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        const info = call.tool_info;
        callsById.set(call.id, {
          name: info.original_tool_name,
          destructive: info.destructive_hint === true,
          isAction: info.read_only_hint !== true && info.effect !== 'inspect',
        });
      }
    } else if (message.role === 'tool') {
      if (toolResultDidNotRun(message.content)) {
        failedIds.add(message.tool_call_id);
      }
    }
  }
  const successes: SuccessfulActionCall[] = [];
  for (const [id, call] of callsById) {
    if (call.isAction && !failedIds.has(id)) {
      successes.push({ name: call.name, destructive: call.destructive });
    }
  }
  return successes;
}

/**
 * The note to append to a finished answer, or undefined when nothing needs marking: no claim, or
 * every claimed family has a matching successful call in the turn behind it.
 */
export function claimedActionNote(input: { content: string; successes: SuccessfulActionCall[] }): string | undefined {
  const claims = detectActionClaims(input.content);
  if (claims.length === 0) {
    return undefined;
  }
  const unmatched = claims.some(family => !claimHasMatchingSuccess({ family, successes: input.successes }));
  return unmatched ? CLAIMED_ACTION_NOTE : undefined;
}
