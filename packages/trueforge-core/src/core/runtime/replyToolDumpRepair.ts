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

/** At least this many of the keys an object shares with a result must carry the result's own values. */
const MIN_EQUAL_VALUES = 2;

/**
 * One tool result from this turn, reduced to what a dump is matched against: the result's
 * top-level keys and values, and its own written lead line (its `summary` field) when it
 * carries one. A result that rides under one naming key contributes two shapes: its own,
 * and the shape of the object inside the key, because a dump can carry either one.
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
export function envelopedResult(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  if (parsed['schema_version'] !== EventType.TOOL_RESPONSE_V2) {
    return undefined;
  }
  const result = parsed['result'];
  return isRecord(result) ? result : undefined;
}

/**
 * The object inside a single-key wrapper: a record with exactly one key whose value is
 * itself a record unwraps to that inner record. Anything else (several keys, or one key
 * holding a plain value) has no inner object. Tools often return their result under one
 * naming key, like { "set": { ... } }, and a dump can carry the wrapper or just the
 * inside, so both sides of the match look exactly one level in, never further.
 */
function singleKeyInner(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const keys = Object.keys(record);
  if (keys.length !== 1) {
    return undefined;
  }
  const only = keys[0];
  if (only === undefined) {
    return undefined;
  }
  const value = record[only];
  return isRecord(value) ? value : undefined;
}

/** One result reduced to its matching shape; the written line is read at this level. */
function resultShape(toolName: string, result: Record<string, unknown>): TurnToolResultShape {
  const summary = result['summary'];
  return {
    toolName,
    keys: new Set(Object.keys(result)),
    values: result,
    summary: typeof summary === 'string' && summary.trim() !== '' ? summary : undefined,
  };
}

/**
 * A value's canonical JSON text: object keys sorted at every level, so two values that
 * are deeply equal produce the same text however their keys were ordered, and different
 * values produce different text.
 */
function canonicalJsonText(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJsonText(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJsonText(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  // Not a JSON value (undefined and the like): one fixed text, distinct from every JSON value's.
  return 'undefined';
}

/** The index of the person's latest genuine message, or -1 when there is none. */
export function turnBoundaryIndex(context: readonly ContextMessage[]): number {
  for (let i = context.length - 1; i >= 0; i -= 1) {
    const message = context[i];
    if (
      message !== undefined &&
      isLLMContextMessage(message) &&
      message.role === 'user' &&
      !isInternalSystemMessage(message)
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * The tool results this turn handed the model, read from the context tail: everything after
 * the person's latest genuine message. An earlier turn's results are not this turn's, so a
 * dump of one of those is left alone. A result that is not a JSON object has no shape to
 * match and is skipped.
 */
export function turnToolResultShapes(context: readonly ContextMessage[]): TurnToolResultShape[] {
  const boundary = turnBoundaryIndex(context);
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
    const toolName = nameByCallId.get(message.tool_call_id) ?? 'unknown';
    shapes.push(resultShape(toolName, result));
    const inner = singleKeyInner(result);
    if (inner !== undefined) {
      shapes.push(resultShape(toolName, inner));
    }
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

/** What stands in a dumped object's place, and the tool whose result it copies. */
interface DumpMatch {
  toolName: string;
  /** The result's own written line to swap in, or '' when the object is taken out instead. */
  replacement: string;
}

/**
 * The result a dumped object copies, judged by shape and by values together. The shape
 * half: at least four keys in common, and at least two thirds of the object's keys are the
 * result's, so a copy trimmed of a few keys still counts. The value half: at least half of
 * the shared keys must carry the result's own values, and at least two must, so an object
 * that merely wears a result's field names (an example in prose, the person's own object
 * quoted back) is left alone: a trimmed copy shares most of its values, those share few or
 * none. When more than one of this turn's results passes, the one the object agrees with
 * on the most values is its source; when two agree equally, no value tells them apart, and
 * the object is taken out rather than replaced with a guessed line.
 */
function matchingResult(
  candidate: Record<string, unknown>,
  results: readonly TurnToolResultShape[],
): DumpMatch | undefined {
  const keys = new Set(Object.keys(candidate));
  let best: TurnToolResultShape | undefined;
  let bestValueMatches = -1;
  let tied = false;
  for (const result of results) {
    let keyMatches = 0;
    let valueMatches = 0;
    for (const key of keys) {
      if (!result.keys.has(key)) {
        continue;
      }
      keyMatches += 1;
      if (canonicalJsonText(candidate[key]) === canonicalJsonText(result.values[key])) {
        valueMatches += 1;
      }
    }
    if (
      keyMatches < MIN_MATCHING_KEYS ||
      keyMatches * 3 < keys.size * 2 ||
      valueMatches < MIN_EQUAL_VALUES ||
      valueMatches * 2 < keyMatches
    ) {
      continue;
    }
    if (valueMatches > bestValueMatches) {
      best = result;
      bestValueMatches = valueMatches;
      tied = false;
    } else if (valueMatches === bestValueMatches) {
      tied = true;
    }
  }
  if (best === undefined) {
    return undefined;
  }
  return { toolName: best.toolName, replacement: tied ? '' : (best.summary ?? '') };
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
    // the whole envelope is what gets repaired. A result under one naming key can be pasted
    // with the key on or left off, so the object inside the key is matched as well; either
    // way the span repaired is the whole object as it stands in the reply.
    const level = envelopedResult(parsed) ?? parsed;
    const inner = singleKeyInner(level);
    const variants = inner === undefined ? [level] : [level, inner];
    let match: DumpMatch | undefined;
    for (const variant of variants) {
      match = matchingResult(variant, results);
      if (match !== undefined) {
        break;
      }
    }
    if (match === undefined) {
      // A JSON object that copies none of this turn's results is the model's own to keep.
      i = end + 1;
      continue;
    }
    const replacement = match.replacement;
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
