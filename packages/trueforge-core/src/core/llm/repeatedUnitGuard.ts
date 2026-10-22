/** A repeated block must reach this many characters (normalized) before it counts as a loop. */
const MIN_REPEAT_CHARS = 20;
/** Repeats are looked for in blocks of one to this many consecutive units. */
const MAX_BLOCK_UNITS = 3;
/** The reply is cut at the first copy once a block has come this many times in a row. */
const STOP_AFTER_REPEATS = 4;
/** A unit with no sentence end is released once it reaches this length, so text never waits long. */
const MAX_UNIT_CHARS = 400;
/** Units remembered for comparison: enough for STOP_AFTER_REPEATS blocks of MAX_BLOCK_UNITS. */
const RECENT_UNITS = 12;

/** A unit ends at a line break, or at a sentence end that is followed by whitespace. */
const UNIT_END = /[.!?](?=\s)|\n/;

/** One complete unit of streamed text. */
interface UnitText {
  /** The text as streamed, from the start of the unit. */
  raw: string;
  /** How much of `raw` was already shown before the unit was complete. */
  shown: number;
}

interface PendingPiece extends UnitText {
  /** The normalized unit text; empty for a blank unit. */
  key: string;
  /** Whether the piece repeats text already seen, so it is held while the loop may still form. */
  suspect: boolean;
}

export interface RepeatedUnitsStep {
  /** Text that is safe to show now. */
  text: string;
  /** Whether a loop was found; the reply ends with `text` and nothing after the first copy is shown. */
  stopped: boolean;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Where the last `copies` non-blank units of the pending pieces begin. Blank pieces ride along with
 * the unit they sit beside, so they are not counted.
 */
function startOfCopies({ pending, copies }: { pending: readonly PendingPiece[]; copies: number }): number {
  if (copies <= 0) {
    return pending.length;
  }
  let seen = 0;
  for (let index = pending.length - 1; index >= 0; index--) {
    if (pending[index]?.key !== '') {
      seen++;
      if (seen === copies) {
        return index;
      }
    }
  }
  return 0;
}

function blockKey({ keys, start, period }: { keys: readonly string[]; start: number; period: number }): string {
  return keys.slice(start, start + period).join(' ');
}

/**
 * Holds back a loop in streamed answer text made of whole sentences or lines, such as one closing
 * line repeated again and again. Text that matches nothing seen before streams straight through.
 * Text that repeats earlier text is held from its first character: a repeat that breaks off is
 * shown after all, and a run that reaches STOP_AFTER_REPEATS ends the reply before its second copy.
 */
export class RepeatedUnitGuard {
  /** The unit still arriving: the text from the last unit break on. */
  #partial = '';
  /** How much of #partial was already shown while it was still arriving. */
  #partialShown = 0;
  /** Units seen but not yet shown, in order. */
  #pending: PendingPiece[] = [];
  /** Normalized keys of the last complete units; blank units are not keys. */
  #recentKeys: string[] = [];
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

  /** Shows what is still held when the reply ends on its own. Nothing is shown after a stop. */
  finish(): string {
    if (this.#stopped) {
      return '';
    }
    const rest = this.#pending.map(piece => this.#shownText(piece)).join('') + this.#partial.slice(this.#partialShown);
    this.#pending = [];
    this.#partial = '';
    this.#partialShown = 0;
    return rest;
  }

  #shownText(piece: UnitText): string {
    return piece.raw.slice(piece.shown);
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

  #addUnit(piece: UnitText): RepeatedUnitsStep {
    const key = normalize(piece.raw);
    if (key === '') {
      // A blank unit joins a held run in order; otherwise it is shown at once.
      if (this.#pending.length === 0) {
        return { text: this.#shownText(piece), stopped: false };
      }
      this.#pending.push({ ...piece, key, suspect: true });
      return { text: '', stopped: false };
    }

    const suspect = this.#recentKeys.includes(key);
    this.#pending.push({ ...piece, key, suspect });
    this.#recentKeys.push(key);
    if (this.#recentKeys.length > RECENT_UNITS) {
      this.#recentKeys.shift();
    }

    const run = this.#findRun();
    // The units of every copy after the first: the reply ends before them, or they wait.
    const copies = run === undefined ? 0 : (run.count - 1) * run.period;
    if (run !== undefined && run.count >= STOP_AFTER_REPEATS) {
      const keep = startOfCopies({ pending: this.#pending, copies });
      const text = this.#pending
        .slice(0, keep)
        .map(item => this.#shownText(item))
        .join('');
      this.#pending = [];
      return { text, stopped: true };
    }

    // A repeat at the end may begin a run, so it waits along with the copies of a run still forming.
    let trailingSuspect = 0;
    for (let index = this.#pending.length - 1; index >= 0 && this.#pending[index]?.suspect === true; index--) {
      trailingSuspect++;
    }
    const holdStart = Math.min(
      startOfCopies({ pending: this.#pending, copies }),
      this.#pending.length - trailingSuspect,
    );
    const released = this.#pending.splice(0, holdStart);
    return { text: released.map(item => this.#shownText(item)).join(''), stopped: false };
  }

  /**
   * Decides the text still arriving. It is shown as it streams unless it is held behind pending
   * copies, or it starts out like text already seen, which may be the start of a repeat.
   */
  #settlePartial(): string {
    const unshown = this.#partial.slice(this.#partialShown);
    if (unshown === '' || this.#pending.length > 0) {
      return '';
    }
    const key = normalize(this.#partial);
    if (this.#partialShown === 0 && key !== '' && this.#recentKeys.some(known => known.startsWith(key))) {
      return '';
    }
    this.#partialShown = this.#partial.length;
    return unshown;
  }

  /** The shortest block at the end of the recent units that repeats back to back, and how often. */
  #findRun(): { period: number; count: number } | undefined {
    const keys = this.#recentKeys;
    for (let period = 1; period <= MAX_BLOCK_UNITS; period++) {
      if (keys.length < 2 * period) {
        continue;
      }
      const block = blockKey({ keys, start: keys.length - period, period });
      if (block.length < MIN_REPEAT_CHARS) {
        continue;
      }
      if (blockKey({ keys, start: keys.length - 2 * period, period }) !== block) {
        continue;
      }
      let count = 2;
      while (
        keys.length >= (count + 1) * period &&
        blockKey({ keys, start: keys.length - (count + 1) * period, period }) === block
      ) {
        count++;
      }
      return { period, count };
    }
    return undefined;
  }
}
