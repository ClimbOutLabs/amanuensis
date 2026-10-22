/**
 * 'leaked' means the reply carried tool-call markup as text. That markup is never shown or run,
 * and the turn is not retried.
 */
export type ToolMarkupOutcome = 'clean' | 'leaked';

/** Closing tags of the markup forms. Alone on a line they are stray markers the person must not see. */
const STRAY_CLOSING_TAGS: readonly string[] = [
  '</tool_calls>',
  '</tool_call>',
  '</invoke>',
  '</｜DSML｜tool_calls>',
  '</｜DSML｜invoke>',
  '</function_results>',
];

/**
 * Text that can open leaked markup. Every one of these also appears in ordinary prose, which
 * names the tags when it explains them, so seeing one starts a candidate instead of a capture:
 * the text is held while its shape is judged, and only a candidate that grows into the full
 * shape of a real call is treated as markup. A candidate that settles as prose is released as
 * the text it always was, and one still forming when the reply ends is released whole. The DSML
 * and chat-template tokens use a fullwidth bar (U+FF5C) inside the brackets; that character is data
 * the detector matches, never text Aman writes itself. A closing tag is a candidate too: alone on
 * its line it is a stray marker and is hidden, while inside a sentence it is prose.
 */
const CANDIDATE_OPENERS: readonly string[] = [
  '<tool_calls',
  '<tool_call',
  '<invoke',
  '<function=',
  '[TOOL_CALLS]',
  '<｜',
  '<function_results',
  ...STRAY_CLOSING_TAGS,
];

const ALL_OPENERS: readonly string[] = [...CANDIDATE_OPENERS];

/** The longest opener, so a stream tail shorter than this can always be held back safely. */
const MAX_OPENER_LENGTH = Math.max(...ALL_OPENERS.map(opener => opener.length));

type CandidateVerdict =
  | { verdict: 'markup' }
  | { verdict: 'dead'; deadLength: number }
  | { verdict: 'stray'; length: number }
  | { verdict: 'undecided' };

/** Whether one completed tag (its text from '<' through '>') carries a name attribute. */
function tagHasName(tag: string): boolean {
  return /\sname\s*=/.test(tag);
}

type InvokeEnvelope = 'complete' | 'forming' | 'none';

/** The two tag shapes one envelope is built from: how a parameter opens, and how the call closes. */
interface EnvelopeShape {
  parameterPrefix: string;
  closingTag: string;
}

const PLAIN_INVOKE_ENVELOPE: EnvelopeShape = { parameterPrefix: '<parameter', closingTag: '</invoke>' };
const DSML_ENVELOPE: EnvelopeShape = {
  parameterPrefix: '<｜DSML｜parameter',
  closingTag: '</｜DSML｜invoke>',
};

/**
 * Where the text after an invoke opening tag stands as a call envelope. The opening tag alone
 * is not a call: the envelope completes only when the closing tag has arrived after the call's
 * parameters. Text after the tag that is neither a parameter nor the start of the closing tag
 * means the envelope can never form (the tag was prose, an example or an explanation), and an
 * envelope still forming when the reply ends is released as text.
 */
function envelopeAfterTag(afterTag: string, shape: EnvelopeShape): InvokeEnvelope {
  const rest = afterTag.trimStart();
  if (rest === '') {
    return 'forming';
  }
  if (rest.startsWith(shape.closingTag)) {
    return 'complete';
  }
  if (rest.startsWith(shape.parameterPrefix)) {
    return rest.includes(shape.closingTag) ? 'complete' : 'forming';
  }
  if (shape.closingTag.startsWith(rest) || shape.parameterPrefix.startsWith(rest)) {
    return 'forming';
  }
  return 'none';
}

/** The envelope standing of text that starts at a plain invoke opening tag. */
function invokeEnvelope(text: string): InvokeEnvelope {
  const tagEnd = text.indexOf('>');
  if (tagEnd === -1) {
    return 'forming';
  }
  return envelopeAfterTag(text.slice(tagEnd + 1), PLAIN_INVOKE_ENVELOPE);
}

const DSML_MARKER = '<｜DSML｜';
const DSML_WRAPPER_TAG = 'tool_calls>';
const DSML_INVOKE_TAG = '<｜DSML｜invoke';

/**
 * Judges held text that opens with the DSML marker. The marker alone is not a call (prose
 * names it, too): the shape is the wrapper or bare invoke tag carrying a name, then the
 * parameters and the closing tag, the same envelope as a plain invoke.
 */
function judgeDsml(text: string): CandidateVerdict {
  const after = text.slice(DSML_MARKER.length);
  if (after === '') {
    return { verdict: 'undecided' };
  }
  let tagAt: number;
  if (after.startsWith('parameter')) {
    // A named parameter is a call's argument on its own: it is never prose that merely names it.
    const tagEnd = text.indexOf('>');
    if (tagEnd === -1) {
      return { verdict: 'undecided' };
    }
    return tagHasName(text.slice(0, tagEnd + 1)) ? { verdict: 'markup' } : { verdict: 'dead', deadLength: tagEnd + 1 };
  } else if (after.startsWith('invoke')) {
    tagAt = 0;
  } else if (after.startsWith(DSML_WRAPPER_TAG)) {
    const inner = text.slice(DSML_MARKER.length + DSML_WRAPPER_TAG.length);
    const trimmed = inner.trimStart();
    if (trimmed === '' || DSML_INVOKE_TAG.startsWith(trimmed)) {
      return { verdict: 'undecided' };
    }
    if (!trimmed.startsWith(DSML_INVOKE_TAG)) {
      return { verdict: 'dead', deadLength: DSML_MARKER.length + DSML_WRAPPER_TAG.length };
    }
    tagAt = text.length - trimmed.length;
  } else if (DSML_WRAPPER_TAG.startsWith(after) || 'invoke'.startsWith(after) || 'parameter'.startsWith(after)) {
    return { verdict: 'undecided' };
  } else {
    return { verdict: 'dead', deadLength: DSML_MARKER.length };
  }
  const tagEnd = text.indexOf('>', tagAt);
  if (tagEnd === -1) {
    return { verdict: 'undecided' };
  }
  if (!tagHasName(text.slice(tagAt, tagEnd + 1))) {
    return { verdict: 'dead', deadLength: tagEnd + 1 };
  }
  const envelope = envelopeAfterTag(text.slice(tagEnd + 1), DSML_ENVELOPE);
  if (envelope === 'complete') {
    return { verdict: 'markup' };
  }
  if (envelope === 'forming') {
    return { verdict: 'undecided' };
  }
  return { verdict: 'dead', deadLength: tagEnd + 1 };
}

/**
 * Judges held text that opens with a results block tag. The block is markup once its closing
 * tag has arrived; before that it may still be prose naming the tag, so it stays undecided.
 */
function judgeFunctionResults(text: string): CandidateVerdict {
  const tagEnd = text.indexOf('>');
  if (tagEnd === -1) {
    return { verdict: 'undecided' };
  }
  return text.includes('</function_results>', tagEnd + 1) ? { verdict: 'markup' } : { verdict: 'undecided' };
}

/**
 * Judges held text that opens with a fullwidth-bar token. A complete chat-template token such as
 * `<｜tool▁call▁begin｜>` is markup by itself; DSML tags need their own shape; anything else with
 * the bar is prose.
 */
function judgeFullwidth(text: string): CandidateVerdict {
  if (/^<｜[^\s<>｜]*｜>/.test(text)) {
    return { verdict: 'markup' };
  }
  if (/^<｜[^\s<>｜]*$/.test(text)) {
    return { verdict: 'undecided' };
  }
  if (text.startsWith(DSML_MARKER)) {
    return judgeDsml(text);
  }
  return { verdict: 'dead', deadLength: '<｜'.length };
}

/** The shape judgment for held text opening with a fullwidth token or a results block tag. */
function judgeShapedOpener(text: string): CandidateVerdict | undefined {
  if (text.startsWith('<｜')) {
    return judgeFullwidth(text);
  }
  if (text.startsWith('<function_results')) {
    return judgeFunctionResults(text);
  }
  return undefined;
}

/**
 * Judges held candidate text by the opener it starts with, against the full shape of a real
 * call for that form. Markup when that shape is present; dead, with the length of text that is
 * plain prose, when the shape can no longer form; undecided while either is still possible.
 */
function judgeOwnShape(text: string, startsLine: boolean): CandidateVerdict {
  const shaped = judgeShapedOpener(text);
  if (shaped !== undefined) {
    return shaped;
  }
  if (text.startsWith('</')) {
    return judgeClosingTag(text, startsLine);
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
    if (after.startsWith('{')) {
      return { verdict: 'markup' };
    }
    // A wrapper that is closed further on is a call that went wrong, not prose: it is broken.
    return text.includes('</tool_call>', tagEnd) ? { verdict: 'markup' } : { verdict: 'dead', deadLength: tagEnd + 1 };
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
  if (text.startsWith('<function=')) {
    // The function-name form: a tag naming the call is markup as soon as it closes.
    const tagEnd = text.indexOf('>');
    if (tagEnd === -1) {
      return { verdict: 'undecided' };
    }
    return /^<function=[\w.-]+>$/.test(text.slice(0, tagEnd + 1))
      ? { verdict: 'markup' }
      : { verdict: 'dead', deadLength: tagEnd + 1 };
  }
  return { verdict: 'undecided' };
}

/**
 * Judges a closing tag that starts a candidate. Alone on its line it is a stray marker, hidden
 * together with the line break after it; anywhere else it is prose and is released as text.
 */
function judgeClosingTag(text: string, startsLine: boolean): CandidateVerdict {
  const tag = STRAY_CLOSING_TAGS.find(candidate => text.startsWith(candidate));
  if (tag === undefined) {
    return { verdict: 'undecided' };
  }
  if (!startsLine) {
    return { verdict: 'dead', deadLength: tag.length };
  }
  const rest = text.slice(tag.length);
  const newlineAt = rest.indexOf('\n');
  const lineRest = newlineAt === -1 ? rest : rest.slice(0, newlineAt);
  if (/[^ \t\r]/.test(lineRest)) {
    return { verdict: 'dead', deadLength: tag.length };
  }
  return { verdict: 'stray', length: tag.length + (newlineAt === -1 ? lineRest.length : newlineAt + 1) };
}

/**
 * Judges held candidate text (starting at a candidate opener). Its own opener's shape decides
 * first, so prose that merely names a tag is settled by the tag itself. A candidate whose own
 * shape is not markup can still hold a complete DSML or results-block shape further in: within
 * the span a dead candidate would release, or anywhere while the candidate is still forming.
 * That shape settles the whole held text as markup, since a call does not stop being a call
 * because a wrapper or a half-formed attempt came first.
 */
function judgeCandidate({ text, startsLine }: { text: string; startsLine: boolean }): CandidateVerdict {
  const own = judgeOwnShape(text, startsLine);
  if (own.verdict === 'markup') {
    return own;
  }
  if (own.verdict === 'stray') {
    return own;
  }
  const limit = own.verdict === 'dead' ? own.deadLength : text.length;
  for (const opener of [DSML_MARKER, '<function_results']) {
    let from = 1;
    for (;;) {
      const at = text.indexOf(opener, from);
      if (at === -1 || at >= limit) {
        break;
      }
      if (judgeShapedOpener(text.slice(at))?.verdict === 'markup') {
        return { verdict: 'markup' };
      }
      from = at + 1;
    }
  }
  return own;
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
  | { kind: 'codeblock'; at: number }
  | { kind: 'candidate'; at: number };

/** Holds streamed answer text back until it is known not to be leaked tool-call markup. */
export class ToolMarkupGuard {
  #pending = '';
  #inMarkup = false;
  /** The marker that opened the fence the scan is inside, or undefined when outside one. */
  #fence: string | undefined;
  /** Where a candidate opener starts in #pending while its shape is judged, if one is open. */
  #candidateAt: number | undefined;
  /** Whether the open candidate starts its line, which decides whether a closing tag is stray. */
  #candidateStartsLine = false;
  /** Whether the scan is inside an indented code block, where nothing is markup. */
  #indented = false;
  /** Whether the next unconsumed character starts a line. */
  #atLineStart = true;
  /** Whether the line consumed so far holds only spaces and tabs. */
  #lineBlank = true;
  /** Whether the last completed line was blank; the start of a reply counts as after a blank line. */
  #prevLineBlank = true;

  /** Feed one streamed text piece; returns the text that is safe to show now. */
  push(text: string): string {
    if (this.#inMarkup) {
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
          emit += this.#take(this.#pending.length - hold);
          return emit;
        }
        emit += this.#take(closeAt + this.#fence.length);
        this.#fence = undefined;
        continue;
      }
      if (this.#candidateAt !== undefined) {
        const candidate = this.#pending.slice(this.#candidateAt);
        const judged = judgeCandidate({ text: candidate, startsLine: this.#candidateStartsLine });
        if (judged.verdict === 'markup') {
          emit += this.#take(this.#candidateAt);
          this.#pending = '';
          this.#candidateAt = undefined;
          this.#inMarkup = true;
          return emit;
        }
        if (judged.verdict === 'stray') {
          // A stray closing tag is hidden with its line break: the text before it is released.
          emit += this.#take(this.#candidateAt);
          this.#take(judged.length);
          this.#candidateAt = undefined;
          continue;
        }
        if (judged.verdict === 'dead') {
          // Prose after all: release the dead token and scan what follows it afresh.
          emit += this.#take(this.#candidateAt + judged.deadLength);
          this.#candidateAt = undefined;
          continue;
        }
        // Undecided: release only what came before the candidate and hold the rest.
        emit += this.#take(this.#candidateAt);
        this.#candidateAt = 0;
        return emit;
      }
      if (this.#indented) {
        const step = this.#consumeIndented();
        emit += step.text;
        if (step.settled) {
          return emit;
        }
        continue;
      }
      const event = this.#nextEvent(this.#pending);
      if (event === undefined) {
        const hold = Math.max(
          this.#heldTailLength(this.#pending),
          this.#anyMarkerTailLength(this.#pending),
          this.#blockScan(this.#pending).tailHold,
        );
        emit += this.#take(this.#pending.length - hold);
        return emit;
      }
      if (event.kind === 'hold') {
        emit += this.#take(event.at);
        return emit;
      }
      if (event.kind === 'fence') {
        emit += this.#take(event.at + event.marker.length);
        this.#fence = event.marker;
        continue;
      }
      if (event.kind === 'text') {
        emit += this.#take(event.through);
        continue;
      }
      if (event.kind === 'codeblock') {
        emit += this.#take(event.at);
        this.#indented = true;
        continue;
      }
      this.#candidateAt = event.at;
      this.#candidateStartsLine = this.#startsLine(event.at);
    }
  }

  /** Whether the text at `at` begins a line: only spaces and tabs come between it and the line break. */
  #startsLine(at: number): boolean {
    const before = this.#pending.slice(0, at);
    const lineBreak = before.lastIndexOf('\n');
    if (lineBreak !== -1) {
      return /^[ \t\r]*$/.test(before.slice(lineBreak + 1));
    }
    return this.#lineBlank && /^[ \t\r]*$/.test(before);
  }

  /** Releases the first `count` characters of the held text, noting where lines begin and end. */
  #take(count: number): string {
    const taken = this.#pending.slice(0, count);
    this.#pending = this.#pending.slice(count);
    this.#noteLineState(taken);
    return taken;
  }

  /** Tracks line position over released text, so an indented block is recognised across pieces. */
  #noteLineState(text: string): void {
    for (const char of text) {
      if (char === '\n') {
        this.#prevLineBlank = this.#lineBlank;
        this.#lineBlank = true;
        this.#atLineStart = true;
      } else {
        this.#atLineStart = false;
        if (char !== ' ' && char !== '\t' && char !== '\r') {
          this.#lineBlank = false;
        }
      }
    }
  }

  /**
   * Releases indented code block lines. A line belongs to the block while it is blank or
   * indented by four spaces; the block ends at the first line that is neither, which is left
   * held for the normal scan. A last line still arriving is released once it is plainly a code
   * line, and held while it could still become either kind.
   */
  #consumeIndented(): { text: string; settled: boolean } {
    let text = '';
    for (;;) {
      const newlineAt = this.#pending.indexOf('\n');
      const line = newlineAt === -1 ? this.#pending : this.#pending.slice(0, newlineAt);
      const indentedLine = line.startsWith('    ');
      const blankLine = !/[^ \t\r]/.test(line);
      if (newlineAt === -1) {
        if (indentedLine && !blankLine) {
          text += this.#take(this.#pending.length);
        } else if (!blankLine) {
          this.#indented = false;
          return { text, settled: false };
        }
        return { text, settled: true };
      }
      if (!indentedLine && !blankLine) {
        this.#indented = false;
        return { text, settled: false };
      }
      text += this.#take(newlineAt + 1);
    }
  }

  /**
   * Walks the lines of the held text once, finding where an indented code block starts, if
   * anywhere: a line indented by four spaces with text on it, after a blank line (the scan's
   * line state covers the first line). Also reports how much of a trailing part-written indent
   * to hold back, since it could still grow into the fourth space.
   */
  #blockScan(text: string): { start: number | undefined; tailHold: number } {
    let pos = 0;
    let prevBlank = this.#prevLineBlank;
    let first = true;
    for (;;) {
      const newlineAt = text.indexOf('\n', pos);
      const end = newlineAt === -1 ? text.length : newlineAt;
      const segment = text.slice(pos, end);
      const canStart = first ? this.#atLineStart : true;
      if (canStart && prevBlank && segment.startsWith('    ') && (/[^ \t\r]/.test(segment) || newlineAt === -1)) {
        return { start: pos, tailHold: 0 };
      }
      if (newlineAt === -1) {
        const tailHold =
          canStart && prevBlank && segment.length >= 1 && segment.length <= 3 && !/[^ \t]/.test(segment)
            ? segment.length
            : 0;
        return { start: undefined, tailHold };
      }
      const soFarBlank = first && !this.#atLineStart ? this.#lineBlank : true;
      prevBlank = soFarBlank && !/[^ \t\r]/.test(segment);
      pos = newlineAt + 1;
      first = false;
    }
  }

  /** The held-back tail, released only by finish when no markup ever came. */
  get heldText(): string {
    return this.#inMarkup ? '' : this.#pending;
  }

  get inMarkup(): boolean {
    return this.#inMarkup || this.#candidateAt !== undefined;
  }

  /** Settles the reply. Markup captured along the way is dropped with it, so nothing in it is ever shown or run. */
  finish(): ToolMarkupOutcome {
    return this.#inMarkup ? 'leaked' : 'clean';
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
    const blockAt = this.#blockScan(text).start;
    if (blockAt !== undefined) {
      offer({ kind: 'codeblock', at: blockAt });
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
