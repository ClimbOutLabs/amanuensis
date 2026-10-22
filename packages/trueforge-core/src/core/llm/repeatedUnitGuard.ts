/** A reply is stopped before a sentence or line that has already come this many times. */
const STOP_AT_COPY = 3;
/** A unit with no sentence end is released once it reaches this length, so text never waits long. */
const MAX_UNIT_CHARS = 400;

/** A unit ends at a line break, or at a sentence end that is followed by whitespace. */
const UNIT_END = /[.!?](?=\s)|\n/;

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

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Rules, fences and other markup with no letters or digits are not sentences, so they never repeat. */
function isSentence(key: string): boolean {
  return /[\p{L}\p{N}]/u.test(key);
}

/**
 * Stops streamed answer text once one whole sentence or line has come STOP_AT_COPY times. Each unit is
 * shown as it completes, and a copy that would be the last one is not shown: the reply ends before it.
 * Text that starts like a sentence already seen twice is held until it is clear it is not that sentence.
 */
export class RepeatedUnitGuard {
  /** The unit still arriving: the text from the last unit break on. */
  #partial = '';
  /** How much of #partial was already shown while it was still arriving. */
  #partialShown = 0;
  /** How many times each normalized sentence has been shown. */
  #copies = new Map<string, number>();
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
    const key = normalize(unit.raw);
    if (!isSentence(key)) {
      return { text: shown, stopped: false };
    }
    const copies = this.#copies.get(key) ?? 0;
    if (copies + 1 >= STOP_AT_COPY) {
      return { text: '', stopped: true };
    }
    this.#copies.set(key, copies + 1);
    return { text: shown, stopped: false };
  }

  /**
   * Decides the text still arriving. It streams as it comes unless it starts like a sentence already
   * seen twice, since that copy may be the one the reply must stop before.
   */
  #settlePartial(): string {
    const unshown = this.#partial.slice(this.#partialShown);
    if (unshown === '' || this.#startsRepeatedSentence(normalize(this.#partial))) {
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
      if (copies + 1 >= STOP_AT_COPY && key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }
}
