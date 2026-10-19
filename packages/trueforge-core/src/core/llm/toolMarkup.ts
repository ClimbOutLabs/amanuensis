/**
 * Leaked tool-call markup: some models, mostly self-hosted ones served with streaming, write their
 * tool calls into the answer text as markup (DeepSeek DSML tags, Hermes tool_call JSON, Mistral
 * [TOOL_CALLS], or an invented function_results block) instead of using the tool channel. Shown raw,
 * the person reads angle brackets and then a claim that something was done when nothing ran.
 *
 * This module owns the text side of that failure. The streaming filter holds back any text that
 * could be the start of markup, so markup never reaches the screen. At the end of the reply the
 * captured markup is either rebuilt into real tool calls, which then go through the same checks and
 * approval cards as any other call, or reported as broken, which stops the answer. A function_results
 * block is a result the model invented for a call that never ran, so it can never be rebuilt.
 */

/** Shown to the person when a reply's tool-call markup could not be rebuilt and the answer stops. */
export const BROKEN_TOOL_MARKUP_MESSAGE =
  'The model tried to use a tool in a broken way, so nothing was done. Try again, or pick another model.';

/** One tool call rebuilt from markup: the tool name and its arguments as a record. */
export interface RecoveredToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type ToolMarkupOutcome =
  { status: 'clean' } | { status: 'recovered'; calls: RecoveredToolCall[] } | { status: 'broken' };

/**
 * Text that opens leaked markup. The DSML form uses a fullwidth bar (U+FF5C) inside the brackets;
 * that character is data the detector matches, never text Aman writes itself.
 */
const MARKUP_OPENERS: readonly string[] = [
  '<｜DSML｜',
  '<function_results',
  '</function_results',
  '<tool_calls',
  '<tool_call',
  '<invoke',
  '<parameter',
  '[TOOL_CALLS]',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The longest opener, so a stream tail shorter than this can always be held back safely. */
const MAX_OPENER_LENGTH = Math.max(...MARKUP_OPENERS.map(opener => opener.length));

/**
 * Holds streamed answer text back until it is known not to be markup. Text before any markup is
 * released as it arrives, minus a short tail that could still grow into an opener. Once an opener
 * matches, everything from it on is captured as markup and nothing more is released: whatever the
 * model writes after its markup (usually the claim that the thing is done) is not shown either.
 */
export class ToolMarkupGuard {
  #pending = '';
  #markup = '';
  #inMarkup = false;

  /** Feed one streamed text piece; returns the text that is safe to show now. */
  push(text: string): string {
    if (this.#inMarkup) {
      this.#markup += text;
      return '';
    }
    this.#pending += text;
    const openerAt = this.#openerIndex(this.#pending);
    if (openerAt !== -1) {
      const emit = this.#pending.slice(0, openerAt);
      this.#markup = this.#pending.slice(openerAt);
      this.#pending = '';
      this.#inMarkup = true;
      return emit;
    }
    const hold = this.#heldTailLength(this.#pending);
    const emit = this.#pending.slice(0, this.#pending.length - hold);
    this.#pending = this.#pending.slice(this.#pending.length - hold);
    return emit;
  }

  /** The held-back tail, released only by finish when no markup ever came. */
  get heldText(): string {
    return this.#inMarkup ? '' : this.#pending;
  }

  get inMarkup(): boolean {
    return this.#inMarkup;
  }

  /** Settles the reply: clean, rebuilt into calls, or broken. */
  finish(): ToolMarkupOutcome {
    if (!this.#inMarkup) {
      return { status: 'clean' };
    }
    return parseToolMarkup(this.#markup);
  }

  #openerIndex(text: string): number {
    let earliest = -1;
    for (const opener of MARKUP_OPENERS) {
      const at = text.indexOf(opener);
      if (at !== -1 && (earliest === -1 || at < earliest)) {
        earliest = at;
      }
    }
    return earliest;
  }

  /** How much of the tail could still be the beginning of an opener and must wait for more text. */
  #heldTailLength(text: string): number {
    const maxHold = Math.min(text.length, MAX_OPENER_LENGTH - 1);
    for (let hold = maxHold; hold > 0; hold--) {
      const tail = text.slice(text.length - hold);
      if (MARKUP_OPENERS.some(opener => opener.startsWith(tail))) {
        return hold;
      }
    }
    return 0;
  }
}

const DSML_INVOKE_PATTERN = /<｜DSML｜invoke name="([^"]+)">([\s\S]*?)<\/｜DSML｜invoke>/g;
const DSML_PARAMETER_PATTERN =
  /<｜DSML｜parameter name="([^"]+)"(?: string="(true|false)")?>([\s\S]*?)<\/｜DSML｜parameter>/g;
const HERMES_CALL_PATTERN = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;

/** Rebuilds the calls in one DSML invoke block; undefined when any part is half-formed. */
function parseDsmlInvoke(body: string): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {};
  let matched = false;
  for (const parameter of body.matchAll(DSML_PARAMETER_PATTERN)) {
    matched = true;
    const name = parameter[1];
    const raw = parameter[3];
    if (name === undefined || raw === undefined) {
      return undefined;
    }
    if (parameter[2] === 'false') {
      try {
        args[name] = JSON.parse(raw.trim());
      } catch {
        return undefined;
      }
    } else {
      args[name] = raw;
    }
  }
  // An invoke whose parameters did not parse as parameters is half-formed, not an empty call.
  if (!matched && body.trim() !== '') {
    return undefined;
  }
  return args;
}

/** The calls in a Mistral [TOOL_CALLS] payload: a JSON list of name and arguments entries. */
function parseMistralCalls(markup: string): RecoveredToolCall[] | undefined {
  const at = markup.indexOf('[TOOL_CALLS]');
  if (at === -1) {
    return undefined;
  }
  const rest = markup.slice(at + '[TOOL_CALLS]'.length).trim();
  if (!rest.startsWith('[')) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rest);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return undefined;
  }
  const calls: RecoveredToolCall[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry['name'] !== 'string' || entry['name'] === '') {
      return undefined;
    }
    const args = entry['arguments'];
    if (args === undefined) {
      calls.push({ name: entry['name'], arguments: {} });
    } else if (isRecord(args)) {
      calls.push({ name: entry['name'], arguments: args });
    } else {
      return undefined;
    }
  }
  return calls;
}

/**
 * Rebuilds real tool calls from captured markup, or reports it broken. Anything that is not a
 * complete, well-formed call in a known markup form is broken: a half-formed call must never run,
 * and a function_results block is an invented result, so it is broken whatever else surrounds it.
 */
export function parseToolMarkup(markup: string): ToolMarkupOutcome {
  if (markup.includes('function_results')) {
    return { status: 'broken' };
  }
  if (markup.includes('<｜DSML｜')) {
    const calls: RecoveredToolCall[] = [];
    for (const invoke of markup.matchAll(DSML_INVOKE_PATTERN)) {
      const name = invoke[1];
      const body = invoke[2];
      if (name === undefined || body === undefined || name === '') {
        return { status: 'broken' };
      }
      const args = parseDsmlInvoke(body);
      if (args === undefined) {
        return { status: 'broken' };
      }
      calls.push({ name, arguments: args });
    }
    return calls.length > 0 ? { status: 'recovered', calls } : { status: 'broken' };
  }
  if (markup.includes('<tool_call')) {
    const calls: RecoveredToolCall[] = [];
    for (const match of markup.matchAll(HERMES_CALL_PATTERN)) {
      const raw = match[1];
      if (raw === undefined) {
        return { status: 'broken' };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { status: 'broken' };
      }
      if (!isRecord(parsed) || typeof parsed['name'] !== 'string' || parsed['name'] === '') {
        return { status: 'broken' };
      }
      const rawArgs = parsed['arguments'];
      if (rawArgs === undefined) {
        calls.push({ name: parsed['name'], arguments: {} });
      } else if (isRecord(rawArgs)) {
        calls.push({ name: parsed['name'], arguments: rawArgs });
      } else if (typeof rawArgs === 'string') {
        try {
          const inner: unknown = JSON.parse(rawArgs);
          if (!isRecord(inner)) {
            return { status: 'broken' };
          }
          calls.push({ name: parsed['name'], arguments: inner });
        } catch {
          return { status: 'broken' };
        }
      } else {
        return { status: 'broken' };
      }
    }
    return calls.length > 0 ? { status: 'recovered', calls } : { status: 'broken' };
  }
  const mistral = parseMistralCalls(markup);
  if (mistral !== undefined) {
    return { status: 'recovered', calls: mistral };
  }
  return { status: 'broken' };
}
