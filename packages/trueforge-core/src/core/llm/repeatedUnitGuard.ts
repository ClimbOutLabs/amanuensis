/** A reply is stopped before a sentence that has already come this many times. */
const STOP_AT_COPY = 3;
/** A reply is stopped before a long sentence that has already come this many times. */
const STOP_AT_LONG_COPY = 2;
/**
 * A sentence with at least this many words counts as long. Two full copies of a long sentence are
 * never a real answer, so long sentences get less tolerance than short ones.
 */
const LONG_SENTENCE_WORDS = 12;
/** Shorter sentences ("Done.", "Yes.") repeat in ordinary answers, so they are never counted. */
const MIN_SENTENCE_WORDS = 6;
/** A unit with no sentence end is released once it reaches this length, so text never waits long. */
const MAX_UNIT_CHARS = 400;

/** A unit ends at a line break, or at a sentence end that is followed by whitespace. */
const UNIT_END = /[.!?](?=\s)|\n/;
/** A fence line opens or closes a code block. */
const FENCE = /^\s*(`{3,}|~{3,})/;
/**
 * List items, headings, table rows and quotes repeat by design, so their lines are not counted. A marker
 * can reach here alone (a sentence end splits "1. " into "1."), hence the end-of-unit alternative.
 */
const STRUCTURED_LINE = /^\s*(?:\||(?:[-*+]|\d+[.)]|#{1,6}|>)(?:\s|$))/;
const INLINE_CODE = /`[^`\n]*`/g;

/** One complete unit of streamed text. */
interface UnitText {
  /** The text as streamed, from the start of the unit. */
  raw: string;
  /** How much of `raw` was already shown before the unit was complete. */
  shown: number;
}

export interface RepeatedUnitsStep {
  /** Text that is safe to show now. */
  text: string;
  /** Whether the reply must stop; nothing after the stop is shown. */
  stopped: boolean;
}

/** Lowercased, single-spaced prose: the form in which two sentences are compared. */
function proseKey(raw: string): string {
  return raw.replace(INLINE_CODE, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isSentence(key: string): boolean {
  return key.split(' ').length >= MIN_SENTENCE_WORDS && /[\p{L}\p{N}]/u.test(key);
}

/** How many copies of this sentence may be shown before the reply stops. */
function stopAtCopy(key: string): number {
  return key.split(' ').length >= LONG_SENTENCE_WORDS ? STOP_AT_LONG_COPY : STOP_AT_COPY;
}

/**
 * Stops streamed answer text once one whole prose sentence has come STOP_AT_COPY times, or
 * STOP_AT_LONG_COPY times for a long sentence. Text in code fences, inline code, list items,
 * headings, tables and short sentences is never counted. Each unit is shown as it completes, and a
 * copy that would be the last one is not shown: the reply ends before it. Text that starts like a
 * sentence whose next copy would stop the reply is held until it is clear it is not that sentence.
 */
export class RepeatedUnitGuard {
  /** The unit still arriving: the text from the last unit break on. */
  #partial = '';
  /** How much of #partial was already shown while it was still arriving. */
  #partialShown = 0;
  /** How many times each prose sentence has been shown. */
  #copies = new Map<string, number>();
  #atLineStart = true;
  #inFence = false;
  /** Whether the line being read is code or structure, so its units are never counted. */
  #lineUncounted = false;
  #stopped = false;

  /** Feed one streamed piece; returns the text that is safe to show now. */
  push(piece: string): RepeatedUnitsStep {
    if (this.#stopped) {
      return { text: '', stopped: true };
    }
    this.#partial += piece;
    let released = '';
    for (let unit = this.#takeUnit(); unit !== undefined; unit = this.#takeUnit()) {
      const step = this.#addUnit(unit);
      released += step.text;
      if (step.stopped) {
        this.#stopped = true;
        return { text: released, stopped: true };
      }
    }
    return { text: released + this.#settlePartial(), stopped: false };
  }

  /** Shows what is still held when the reply ends on its own. */
  finish(): RepeatedUnitsStep {
    if (this.#stopped || this.#partial === '') {
      return { text: '', stopped: this.#stopped };
    }
    const step = this.#addUnit({ raw: this.#partial, shown: this.#partialShown });
    this.#partial = '';
    this.#partialShown = 0;
    this.#stopped = step.stopped;
    return step;
  }

  #takeUnit(): UnitText | undefined {
    const end = UNIT_END.exec(this.#partial);
    let cut: number;
    if (end !== null) {
      cut = end.index + end[0].length;
    } else if (this.#partial.length >= MAX_UNIT_CHARS) {
      cut = MAX_UNIT_CHARS;
    } else {
      return undefined;
    }
    const unit: UnitText = { raw: this.#partial.slice(0, cut), shown: this.#partialShown };
    this.#partial = this.#partial.slice(cut);
    this.#partialShown = 0;
    return unit;
  }

  #addUnit(unit: UnitText): RepeatedUnitsStep {
    const shown = unit.raw.slice(unit.shown);
    const key = this.#countedKey(unit.raw);
    if (key === undefined) {
      return { text: shown, stopped: false };
    }
    const copies = this.#copies.get(key) ?? 0;
    if (copies + 1 >= stopAtCopy(key)) {
      return { text: '', stopped: true };
    }
    this.#copies.set(key, copies + 1);
    return { text: shown, stopped: false };
  }

  /**
   * The prose key of a completed unit when it counts as a sentence, otherwise undefined. Also advances
   * the line state: a fence toggles code, and the first unit of a line decides whether the line counts.
   */
  #countedKey(raw: string): string | undefined {
    if (this.#atLineStart) {
      if (FENCE.test(raw)) {
        this.#inFence = !this.#inFence;
        this.#lineUncounted = true;
      } else {
        this.#lineUncounted = this.#inFence || STRUCTURED_LINE.test(raw);
      }
    }
    this.#atLineStart = raw.endsWith('\n');
    if (this.#lineUncounted) {
      return undefined;
    }
    const key = proseKey(raw);
    return isSentence(key) ? key : undefined;
  }

  /**
   * Decides the text still arriving. It streams as it comes unless it starts like a sentence whose
   * next copy would stop the reply, since that copy may be the one the reply must stop before.
   */
  #settlePartial(): string {
    const unshown = this.#partial.slice(this.#partialShown);
    if (unshown === '' || this.#startsRepeatedSentence(proseKey(this.#partial))) {
      return '';
    }
    this.#partialShown = this.#partial.length;
    return unshown;
  }

  #startsRepeatedSentence(prefix: string): boolean {
    if (prefix === '') {
      return false;
    }
    for (const [key, copies] of this.#copies) {
      if (copies + 1 >= stopAtCopy(key) && key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }
}
