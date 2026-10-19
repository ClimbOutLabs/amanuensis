/**
 * Leaked tool-call markup: some models, mostly self-hosted ones served with streaming, write their
 * tool calls into the answer text as markup (DeepSeek DSML tags, Hermes tool_call JSON, Mistral
 * [TOOL_CALLS], or an invented function_results block) instead of using the tool channel. Shown raw,
 * the person reads angle brackets and then a claim that something was done when nothing ran.
 *
 * This module owns the text side of that failure. The streaming filter holds back any text that
 * could grow into markup, so markup never reaches the screen. At the end of the reply the
 * captured markup is either rebuilt into real tool calls, which then go through the same checks and
 * approval cards as any other call, or reported as broken, which stops the answer. A function_results
 * block is a result the model invented for a call that never ran, so it can never be rebuilt.
 * Markup shown inside a fenced code block or an inline code span is an example the person asked
 * to see, not a call: the filter treats it as ordinary text and never captures it. The same goes
 * for prose that merely names a tag: only text with the full shape of a real call (the envelope
 * and the start of its payload) is treated as markup, so an answer explaining the tags streams
 * like any other answer.
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
 * Text that opens leaked markup on its own: seeing one of these is enough to hold the text as
 * markup. The DSML form uses a fullwidth bar (U+FF5C) inside the brackets; that character is
 * data the detector matches, never text Aman writes itself.
 */
const STRONG_OPENERS: readonly string[] = ['<｜DSML｜', '<function_results', '</function_results'];

/**
 * Text that can open leaked markup but also appears in ordinary prose, which names these tags
 * when it explains them. One of these starts a candidate instead: the text is held while its
 * shape is judged, and only a candidate that grows into the full shape of a real call is treated
 * as markup. A candidate that settles as prose is released as the text it always was.
 */
const CANDIDATE_OPENERS: readonly string[] = ['<tool_calls', '<tool_call', '<invoke', '[TOOL_CALLS]'];

const ALL_OPENERS: readonly string[] = [...STRONG_OPENERS, ...CANDIDATE_OPENERS];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The longest opener, so a stream tail shorter than this can always be held back safely. */
const MAX_OPENER_LENGTH = Math.max(...ALL_OPENERS.map(opener => opener.length));

type CandidateVerdict = { verdict: 'markup' } | { verdict: 'dead'; deadLength: number } | { verdict: 'undecided' };

/** Whether one completed tag (its text from '<' through '>') carries a name attribute. */
function tagHasName(tag: string): boolean {
  return /\sname\s*=/.test(tag);
}

type InvokeEnvelope = 'complete' | 'forming' | 'none';

/**
 * Where the text starting at an invoke opening tag stands as a call envelope. The opening tag
 * alone is not a call: the envelope completes only when the closing tag has arrived after the
 * call's parameters. Text after the tag that is neither a parameter nor the start of the
 * closing tag means the envelope can never form (the tag was prose, an example or an
 * explanation), and an envelope still forming when the reply ends is released as text.
 */
function invokeEnvelope(text: string): InvokeEnvelope {
  const tagEnd = text.indexOf('>');
  if (tagEnd === -1) {
    return 'forming';
  }
  const rest = text.slice(tagEnd + 1).trimStart();
  if (rest === '') {
    return 'forming';
  }
  if (rest.startsWith('</invoke>')) {
    return 'complete';
  }
  if (rest.startsWith('<parameter')) {
    return rest.includes('</invoke>') ? 'complete' : 'forming';
  }
  if ('</invoke>'.startsWith(rest) || '<parameter'.startsWith(rest)) {
    return 'forming';
  }
  return 'none';
}

/**
 * Judges held candidate text (starting at a candidate opener) against the full shape of a real
 * call. Markup when that shape is present; dead, with the length of text that is plain prose,
 * when the shape can no longer form; undecided while either is still possible.
 */
function judgeCandidate(text: string): CandidateVerdict {
  if (STRONG_OPENERS.some(opener => text.includes(opener))) {
    return { verdict: 'markup' };
  }
  if (text.startsWith('[TOOL_CALLS]')) {
    // The Mistral form: the marker and then the list of calls itself.
    const rest = text.slice('[TOOL_CALLS]'.length).trimStart();
    if (rest === '') {
      return { verdict: 'undecided' };
    }
    return rest.startsWith('[') ? { verdict: 'markup' } : { verdict: 'dead', deadLength: '[TOOL_CALLS]'.length };
  }
  if (text.startsWith('<tool_calls')) {
    // The plain XML form: a call is an invoke inside the wrapper whose envelope completes.
    const closeAt = text.indexOf('</tool_calls>');
    let searchFrom = 0;
    for (;;) {
      const invokeAt = text.indexOf('<invoke', searchFrom);
      if (invokeAt === -1) {
        return closeAt === -1
          ? { verdict: 'undecided' }
          : { verdict: 'dead', deadLength: closeAt + '</tool_calls>'.length };
      }
      const tagEnd = text.indexOf('>', invokeAt);
      if (tagEnd === -1) {
        return { verdict: 'undecided' };
      }
      if (tagHasName(text.slice(invokeAt, tagEnd + 1))) {
        const envelope = invokeEnvelope(text.slice(invokeAt));
        if (envelope === 'complete') {
          return { verdict: 'markup' };
        }
        if (envelope === 'forming') {
          return { verdict: 'undecided' };
        }
      }
      searchFrom = tagEnd + 1;
    }
  }
  if (text.startsWith('<tool_call')) {
    // The Hermes form: the tag and then its JSON payload.
    const tagEnd = text.indexOf('>');
    if (tagEnd === -1) {
      return { verdict: 'undecided' };
    }
    const after = text.slice(tagEnd + 1).trimStart();
    if (after === '') {
      return { verdict: 'undecided' };
    }
    return after.startsWith('{') ? { verdict: 'markup' } : { verdict: 'dead', deadLength: tagEnd + 1 };
  }
  if (text.startsWith('<invoke')) {
    // A lone invoke is a call only when its envelope completes: the parameters and then the
    // closing tag. The named opening tag alone is prose as often as it is a call.
    const tagEnd = text.indexOf('>');
    if (tagEnd === -1) {
      return { verdict: 'undecided' };
    }
    if (!tagHasName(text.slice(0, tagEnd + 1))) {
      return { verdict: 'dead', deadLength: tagEnd + 1 };
    }
    const envelope = invokeEnvelope(text);
    if (envelope === 'complete') {
      return { verdict: 'markup' };
    }
    if (envelope === 'forming') {
      return { verdict: 'undecided' };
    }
    return { verdict: 'dead', deadLength: tagEnd + 1 };
  }
  return { verdict: 'undecided' };
}

/**
 * The end of the inline code span a backtick run opens, when the run sits at `at` and is
 * `length` backticks long: the index just past the closing run (a run of the same length, on
 * the same line). 'open' when the text in hand cannot settle it yet (no closing run and no
 * line end seen), and undefined when the run opens no span: the line ends first, so the
 * backticks are literal text.
 */
function inlineSpanEnd(input: { text: string; at: number; length: number }): number | 'open' | undefined {
  const { text, at, length } = input;
  let index = at + length;
  while (index < text.length) {
    const char = text[index];
    if (char === '\n') {
      return undefined;
    }
    if (char === '`') {
      let runEnd = index;
      while (runEnd < text.length && text[runEnd] === '`') {
        runEnd++;
      }
      if (runEnd - index === length) {
        return runEnd;
      }
      index = runEnd;
      continue;
    }
    index++;
  }
  return 'open';
}

type ScanEvent =
  | { kind: 'fence'; at: number; marker: string }
  | { kind: 'text'; at: number; through: number }
  | { kind: 'hold'; at: number }
  | { kind: 'strong'; at: number }
  | { kind: 'candidate'; at: number };

/**
 * Holds streamed answer text back until it is known not to be markup. Text before any markup is
 * released as it arrives, minus a short tail that could still grow into an opener. Once markup
 * is certain, everything from it on is captured and nothing more is released: whatever the
 * model writes after its markup (usually the claim that the thing is done) is not shown either.
 * Inside a fenced code block or an inline code span nothing is markup: that text is released
 * as it arrives, and only an opener after the code ends can start a capture. A candidate opener
 * holds its text only until the shape is judged: prose is released, a real call is captured.
 */
export class ToolMarkupGuard {
  #pending = '';
  #markup = '';
  #inMarkup = false;
  /** The marker that opened the fence the scan is inside, or undefined when outside one. */
  #fence: string | undefined;
  /** Where a candidate opener starts in #pending while its shape is judged, if one is open. */
  #candidateAt: number | undefined;

  /** Feed one streamed text piece; returns the text that is safe to show now. */
  push(text: string): string {
    if (this.#inMarkup) {
      this.#markup += text;
      return '';
    }
    this.#pending += text;
    let emit = '';
    for (;;) {
      if (this.#fence !== undefined) {
        const closeAt = this.#pending.indexOf(this.#fence);
        if (closeAt === -1) {
          // All of this is fence text; only a tail that could grow into the closing fence waits.
          const hold = this.#markerTailLength({ text: this.#pending, char: this.#fence.charAt(0) });
          emit += this.#pending.slice(0, this.#pending.length - hold);
          this.#pending = this.#pending.slice(this.#pending.length - hold);
          return emit;
        }
        emit += this.#pending.slice(0, closeAt + this.#fence.length);
        this.#pending = this.#pending.slice(closeAt + this.#fence.length);
        this.#fence = undefined;
        continue;
      }
      if (this.#candidateAt !== undefined) {
        const candidate = this.#pending.slice(this.#candidateAt);
        const judged = judgeCandidate(candidate);
        if (judged.verdict === 'markup') {
          emit += this.#pending.slice(0, this.#candidateAt);
          this.#markup = candidate;
          this.#pending = '';
          this.#candidateAt = undefined;
          this.#inMarkup = true;
          return emit;
        }
        if (judged.verdict === 'dead') {
          // Prose after all: release the dead token and scan what follows it afresh.
          const through = this.#candidateAt + judged.deadLength;
          emit += this.#pending.slice(0, through);
          this.#pending = this.#pending.slice(through);
          this.#candidateAt = undefined;
          continue;
        }
        // Undecided: release only what came before the candidate and hold the rest.
        emit += this.#pending.slice(0, this.#candidateAt);
        this.#pending = this.#pending.slice(this.#candidateAt);
        this.#candidateAt = 0;
        return emit;
      }
      const event = this.#nextEvent(this.#pending);
      if (event === undefined) {
        const hold = Math.max(this.#heldTailLength(this.#pending), this.#anyMarkerTailLength(this.#pending));
        emit += this.#pending.slice(0, this.#pending.length - hold);
        this.#pending = this.#pending.slice(this.#pending.length - hold);
        return emit;
      }
      if (event.kind === 'hold') {
        emit += this.#pending.slice(0, event.at);
        this.#pending = this.#pending.slice(event.at);
        return emit;
      }
      if (event.kind === 'fence') {
        emit += this.#pending.slice(0, event.at + event.marker.length);
        this.#pending = this.#pending.slice(event.at + event.marker.length);
        this.#fence = event.marker;
        continue;
      }
      if (event.kind === 'text') {
        emit += this.#pending.slice(0, event.through);
        this.#pending = this.#pending.slice(event.through);
        continue;
      }
      if (event.kind === 'strong') {
        emit += this.#pending.slice(0, event.at);
        this.#markup = this.#pending.slice(event.at);
        this.#pending = '';
        this.#inMarkup = true;
        return emit;
      }
      this.#candidateAt = event.at;
    }
  }

  /** The held-back tail, released only by finish when no markup ever came. */
  get heldText(): string {
    return this.#inMarkup ? '' : this.#pending;
  }

  get inMarkup(): boolean {
    return this.#inMarkup || this.#candidateAt !== undefined;
  }

  /** Settles the reply: clean, rebuilt into calls, or broken. */
  finish(): ToolMarkupOutcome {
    if (!this.#inMarkup) {
      return { status: 'clean' };
    }
    return parseToolMarkup(this.#markup);
  }

  /** The earliest thing in the text the scan must act on, or undefined when it is plain text. */
  #nextEvent(text: string): ScanEvent | undefined {
    let best: ScanEvent | undefined;
    const offer = (event: ScanEvent): void => {
      if (best === undefined || event.at < best.at) {
        best = event;
      }
    };
    const tildeAt = text.indexOf('~~~');
    if (tildeAt !== -1) {
      offer({ kind: 'fence', at: tildeAt, marker: '~~~' });
    }
    const runAt = text.indexOf('`');
    if (runAt !== -1) {
      let runEnd = runAt;
      while (runEnd < text.length && text[runEnd] === '`') {
        runEnd++;
      }
      const length = runEnd - runAt;
      const span = inlineSpanEnd({ text, at: runAt, length });
      if (span === 'open') {
        offer({ kind: 'hold', at: runAt });
      } else if (span !== undefined) {
        offer({ kind: 'text', at: runAt, through: span });
      } else if (length >= 3) {
        offer({ kind: 'fence', at: runAt, marker: '```' });
      } else {
        offer({ kind: 'text', at: runAt, through: runEnd });
      }
    }
    for (const opener of STRONG_OPENERS) {
      const at = text.indexOf(opener);
      if (at !== -1) {
        offer({ kind: 'strong', at });
      }
    }
    for (const opener of CANDIDATE_OPENERS) {
      const at = text.indexOf(opener);
      if (at !== -1) {
        offer({ kind: 'candidate', at });
      }
    }
    return best;
  }

  /** How much of the tail is a run of one fence character that could still grow into a marker. */
  #markerTailLength(input: { text: string; char: string }): number {
    const { text, char } = input;
    let run = 0;
    for (let index = text.length - 1; index >= 0 && text.charAt(index) === char; index--) {
      run++;
    }
    return Math.min(run, 2);
  }

  /** The fence-character tail for either marker, when the text ends mid-run. */
  #anyMarkerTailLength(text: string): number {
    const last = text.charAt(text.length - 1);
    return last === '`' || last === '~' ? this.#markerTailLength({ text, char: last }) : 0;
  }

  /** How much of the tail could still be the beginning of an opener and must wait for more text. */
  #heldTailLength(text: string): number {
    const maxHold = Math.min(text.length, MAX_OPENER_LENGTH - 1);
    for (let hold = maxHold; hold > 0; hold--) {
      const tail = text.slice(text.length - hold);
      if (ALL_OPENERS.some(opener => opener.startsWith(tail))) {
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
