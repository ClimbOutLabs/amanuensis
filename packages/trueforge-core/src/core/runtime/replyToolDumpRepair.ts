import { EventType } from '../events/schema';
import { isRecord } from '../util/records';
import type { ContextMessage } from './AgentThread.types';
import { isInternalSystemMessage, isLLMContextMessage } from './contextUtils';

/**
 * Saved in place of a reply that was only a dumped tool result: the result came back, but the
 * reply never put it in words, and the result itself carries no written line to keep.
 */
export const TOOL_RESULT_DUMP_FALLBACK_LINE =
  'The result came back, but it was not written out in words here. Ask me again and I will put it in words.';

/** A dumped object counts as a copy of a result only when at least this many of its keys are the result's. */
const MIN_MATCHING_KEYS = 4;

/**
 * One tool result from this turn, reduced to what a dump is matched against: the result's
 * top-level keys and values, and its own written lead line (its `summary` field) when it
 * carries one.
 */
export interface TurnToolResultShape {
  toolName: string;
  keys: ReadonlySet<string>;
  values: Readonly<Record<string, unknown>>;
  summary: string | undefined;
}

/**
 * The result object inside a tool response envelope, or undefined when the parsed content
 * is not one. Tool results reach the model wrapped as { schema_version, outcome, result },
 * and the tool's own result is the `result` object; a bare result object (older or
 * host-made messages) is its own shape and returns undefined here.
 */
function envelopedResult(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  if (parsed['schema_version'] !== EventType.TOOL_RESPONSE_V2) {
    return undefined;
  }
  const result = parsed['result'];
  return isRecord(result) ? result : undefined;
}

/**
 * The tool results this turn handed the model, read from the context tail: everything after
 * the person's latest genuine message. An earlier turn's results are not this turn's, so a
 * dump of one of those is left alone. A result that is not a JSON object has no shape to
 * match and is skipped.
 */
export function turnToolResultShapes(context: readonly ContextMessage[]): TurnToolResultShape[] {
  let boundary = -1;
  for (let i = context.length - 1; i >= 0; i -= 1) {
    const message = context[i];
    if (
      message !== undefined &&
      isLLMContextMessage(message) &&
      message.role === 'user' &&
      !isInternalSystemMessage(message)
    ) {
      boundary = i;
      break;
    }
  }
  const nameByCallId = new Map<string, string>();
  for (let i = boundary + 1; i < context.length; i += 1) {
    const message = context[i];
    if (message === undefined || !isLLMContextMessage(message) || message.role !== 'assistant') {
      continue;
    }
    for (const call of message.tool_calls ?? []) {
      nameByCallId.set(call.id, call.function.name);
    }
  }
  const shapes: TurnToolResultShape[] = [];
  for (let i = boundary + 1; i < context.length; i += 1) {
    const message = context[i];
    if (message === undefined || !isLLMContextMessage(message) || message.role !== 'tool') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    const result = envelopedResult(parsed) ?? parsed;
    const summary = result['summary'];
    shapes.push({
      toolName: nameByCallId.get(message.tool_call_id) ?? 'unknown',
      keys: new Set(Object.keys(result)),
      values: result,
      summary: typeof summary === 'string' && summary.trim() !== '' ? summary : undefined,
    });
  }
  return shapes;
}

const JSON_WORD = /\bjson\b/i;
const RAW_RESULT_WORDS = /\braw\s+(?:result|results|output|data|response|object|dump)\b/i;

/**
 * Whether the person's message asks for the data itself, as JSON or raw. Then a JSON object
 * in the reply is what was asked for, not a dump, and the reply is left untouched.
 * Deliberately wide: leaving a dump in place costs less than taking out data the person
 * asked to see.
 */
export function messageAsksForJson(text: string): boolean {
  return JSON_WORD.test(text) || RAW_RESULT_WORDS.test(text);
}

interface ReplySegment {
  start: number;
  end: number;
  fenced: boolean;
}

const FENCE_LINE = /^\s*(?:```|~~~)/;

/** The reply split into fenced code and the prose around it. Only the prose is ever repaired. */
function replySegments(text: string): ReplySegment[] {
  const segments: ReplySegment[] = [];
  const push = (start: number, end: number, fenced: boolean) => {
    if (end > start) {
      segments.push({ start, end, fenced });
    }
  };
  let fenced = false;
  let segmentStart = 0;
  let segmentFenced = false;
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline + 1;
    if (FENCE_LINE.test(text.slice(lineStart, lineEnd))) {
      if (!fenced) {
        // The opening fence line belongs to the code side: close the prose segment before it.
        push(segmentStart, lineStart, segmentFenced);
        segmentStart = lineStart;
        segmentFenced = true;
        fenced = true;
      } else {
        // The closing fence line ends the fenced segment.
        push(segmentStart, lineEnd, segmentFenced);
        segmentStart = lineEnd;
        segmentFenced = false;
        fenced = false;
      }
    }
    lineStart = lineEnd;
  }
  push(segmentStart, text.length, segmentFenced);
  return segments;
}

/** Index of the closing brace of the object opened at `start`, or -1 when it never closes. Braces inside strings do not count. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * The result a dumped object most likely copies. The gate is the shape: at least four keys
 * in common, and at least two thirds of the object's keys are the result's, so a copy
 * trimmed of a few keys still counts while a different object that happens to share a few
 * field names does not. When more than one of this turn's results passes the gate (two
 * calls to similar tools can return near-identical shapes), the one whose values the object
 * also carries is the copy's source.
 */
function matchingResult(
  candidate: Record<string, unknown>,
  results: readonly TurnToolResultShape[],
): TurnToolResultShape | undefined {
  const keys = new Set(Object.keys(candidate));
  let best: TurnToolResultShape | undefined;
  let bestValueMatches = -1;
  let bestKeyMatches = 0;
  for (const result of results) {
    let keyMatches = 0;
    let valueMatches = 0;
    for (const key of keys) {
      if (!result.keys.has(key)) {
        continue;
      }
      keyMatches += 1;
      if (JSON.stringify(candidate[key]) === JSON.stringify(result.values[key])) {
        valueMatches += 1;
      }
    }
    if (keyMatches < MIN_MATCHING_KEYS || keyMatches * 3 < keys.size * 2) {
      continue;
    }
    if (valueMatches > bestValueMatches || (valueMatches === bestValueMatches && keyMatches > bestKeyMatches)) {
      best = result;
      bestValueMatches = valueMatches;
      bestKeyMatches = keyMatches;
    }
  }
  return best;
}

interface SegmentRepair {
  text: string;
  /** The tool whose result the first repaired dump in this segment came from; undefined when nothing was repaired. */
  toolName: string | undefined;
}

/**
 * Repairs every dumped result in one prose segment. A dump is replaced by its result's own
 * written lead line when the result carries one, and taken out when it does not, leaving the
 * prose around it standing.
 */
function repairSegment(segmentText: string, results: readonly TurnToolResultShape[]): SegmentRepair {
  let out = '';
  let copied = 0;
  let i = 0;
  let toolName: string | undefined;
  while (i < segmentText.length) {
    if (segmentText.charAt(i) !== '{') {
      i += 1;
      continue;
    }
    const end = objectEnd(segmentText, i);
    if (end === -1) {
      i += 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(segmentText.slice(i, end + 1));
    } catch {
      i += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      i = end + 1;
      continue;
    }
    // A pasted envelope is a dump of the result it wraps: match on the wrapped result, and
    // the whole envelope is what gets repaired.
    const match = matchingResult(envelopedResult(parsed) ?? parsed, results);
    if (match === undefined) {
      // A JSON object that copies none of this turn's results is the model's own to keep.
      i = end + 1;
      continue;
    }
    const replacement = match.summary ?? '';
    let spanStart = i;
    let spanEnd = end + 1;
    if (replacement === '') {
      // Swallow the blank space around a removed dump, so its taking out leaves no hole:
      // trailing spaces and one newline on each side.
      while (
        spanEnd < segmentText.length &&
        (segmentText.charAt(spanEnd) === ' ' || segmentText.charAt(spanEnd) === '\t')
      ) {
        spanEnd += 1;
      }
      if (segmentText.charAt(spanEnd) === '\n') {
        spanEnd += 1;
      }
      while (
        spanStart > copied &&
        (segmentText.charAt(spanStart - 1) === ' ' || segmentText.charAt(spanStart - 1) === '\t')
      ) {
        spanStart -= 1;
      }
      if (spanStart > copied && segmentText.charAt(spanStart - 1) === '\n') {
        spanStart -= 1;
      }
    }
    out += segmentText.slice(copied, spanStart) + replacement;
    copied = spanEnd;
    i = spanEnd;
    toolName ??= match.toolName;
  }
  out += segmentText.slice(copied);
  if (toolName !== undefined) {
    out = out.replace(/\n{3,}/g, '\n\n');
  }
  return { text: out, toolName };
}

/** A repaired reply, with the tool whose result had been dumped. */
export interface ToolResultDumpRepair {
  text: string;
  toolName: string;
}

/**
 * Repairs a settled reply that carries one of this turn's tool results pasted as raw JSON
 * instead of words. Detection is by shape, not by exact text: a copy trimmed of a few keys
 * still matches its result. Code fences are never touched, and neither is a reply whose
 * person asked for the data in that shape. Returns undefined when nothing was repaired.
 */
export function repairToolResultDump(input: {
  text: string;
  results: readonly TurnToolResultShape[];
  personAskedForJson: boolean;
}): ToolResultDumpRepair | undefined {
  if (input.personAskedForJson || input.results.length === 0) {
    return undefined;
  }
  let repaired = '';
  let toolName: string | undefined;
  for (const segment of replySegments(input.text)) {
    const slice = input.text.slice(segment.start, segment.end);
    if (segment.fenced) {
      repaired += slice;
      continue;
    }
    const segmentRepair = repairSegment(slice, input.results);
    repaired += segmentRepair.text;
    toolName ??= segmentRepair.toolName;
  }
  if (toolName === undefined) {
    return undefined;
  }
  const trimmed = repaired.trim();
  return { text: trimmed === '' ? TOOL_RESULT_DUMP_FALLBACK_LINE : trimmed, toolName };
}
