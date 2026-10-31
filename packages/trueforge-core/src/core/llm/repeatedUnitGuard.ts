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
/**
 * Short sentences are not counted one by one, but a reply that keeps cycling through ones it already
 * wrote ("Done. All set. Ready. Done. Final. All set.") is a model stuck signing off. The reply stops
 * before the short sentence that would make SHORT_LOOP_REPEATS repeats in a row, with no new words
 * between them, once at least SHORT_LOOP_KEYS different sentences are in that run. Anything new (a new
 * sentence, a heading, a day's name) ends the run, so lists and schedules that reuse short lines never stop.
 */
const SHORT_LOOP_REPEATS = 8;
const SHORT_LOOP_KEYS = 3;
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

/** The words of a short sentence alone, so "Done.", "Done ✓" and "done!" are one sentence. */
function shortKey(key: string): string {
  return key
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
 * STOP_AT_LONG_COPY times for a long sentence, or once short sentences keep cycling (SHORT_LOOP_REPEATS).
 * Text in code fences, inline code, list items, headings and tables is never counted. Each unit is shown as it completes, and a
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
  /** How many times each short sentence has been shown. */
  #shortCopies = new Map<string, number>();
  /** The short sentences repeated in a row at the end of the reply, with no new words between them. */
  #repeatRun: string[] = [];
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
    const counted = this.#countedKey(unit.raw);
    if (counted === undefined) {
      if (/[\p{L}\p{N}]/u.test(unit.raw)) {
        this.#repeatRun = [];
      }
      return { text: shown, stopped: false };
    }
    if (!counted.short) {
      this.#repeatRun = [];
    }
    if (counted.short) {
      return this.#addShortUnit({ key: counted.key, shown });
    }
    const key = counted.key;
    const copies = this.#copies.get(key) ?? 0;
    if (copies + 1 >= stopAtCopy(key)) {
      return { text: '', stopped: true };
    }
    this.#copies.set(key, copies + 1);
    return { text: shown, stopped: false };
  }

  #addShortUnit({ key, shown }: { key: string; shown: string }): RepeatedUnitsStep {
    const copies = this.#shortCopies.get(key) ?? 0;
    this.#shortCopies.set(key, copies + 1);
    if (copies === 0) {
      this.#repeatRun = [];
      return { text: shown, stopped: false };
    }
    if (this.#shortLoopArmed(key)) {
      return { text: '', stopped: true };
    }
    this.#repeatRun.push(key);
    return { text: shown, stopped: false };
  }

  /** Whether one more repeat, of `next`, would complete a sign-off loop. */
  #shortLoopArmed(next: string): boolean {
    if (this.#repeatRun.length + 1 < SHORT_LOOP_REPEATS) {
      return false;
    }
    return new Set([...this.#repeatRun, next]).size >= SHORT_LOOP_KEYS;
  }

  /**
   * The key of a completed unit when it counts, and whether it is a short sentence, otherwise undefined.
   * Also advances the line state: a fence toggles code, and the first unit of a line decides whether the
   * line counts.
   */
  #countedKey(raw: string): { key: string; short: boolean } | undefined {
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
    if (isSentence(key)) {
      return { key, short: false };
    }
    // A short unit counts only as a finished sentence: a bold label such as "**Morning**" repeats by design.
    const short = shortKey(key);
    return /[.!?]["')\]]*$/.test(raw.trim()) && /[\p{L}\p{N}]/u.test(short) ? { key: short, short: true } : undefined;
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
    const shortPrefix = shortKey(prefix);
    for (const key of this.#shortCopies.keys()) {
      if (key.startsWith(shortPrefix) && this.#shortLoopArmed(key)) {
        return true;
      }
    }
    for (const [key, copies] of this.#copies) {
      if (copies + 1 >= stopAtCopy(key) && key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }
}
