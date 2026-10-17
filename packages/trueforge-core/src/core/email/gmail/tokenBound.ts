/** Tokens of email content one tool call may put in front of the model. */
export const MAX_TOKENS_PER_CALL = 8000;

/** Longest snippet a result carries. */
const SNIPPET_CHAR_CAP = 200;

/**
 * A cheap, conservative token estimate. Latin text runs near four characters a token, but other scripts take
 * about one token a character, so counting characters alone would let a Japanese or Arabic thread overshoot
 * the bound several times over.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) < 0x80) {
      ascii += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(ascii / 4) + other;
}

/** The longest prefix of the text within the token budget, cut on a code point. */
export function truncateToTokens(input: { text: string; maxTokens: number }): { text: string; truncated: boolean } {
  if (estimateTokens(input.text) <= input.maxTokens) {
    return { text: input.text, truncated: false };
  }
  let used = 0;
  let asciiRun = 0;
  let kept = '';
  for (const character of input.text) {
    const isAscii = (character.codePointAt(0) ?? 0) < 0x80;
    const next = isAscii ? (asciiRun % 4 === 0 ? 1 : 0) : 1;
    if (used + next > input.maxTokens) {
      break;
    }
    used += next;
    asciiRun = isAscii ? asciiRun + 1 : 0;
    kept += character;
  }
  return { text: kept, truncated: true };
}

/** One line of text, cut to the snippet cap. */
export function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHAR_CAP ? `${flat.slice(0, SNIPPET_CHAR_CAP)}...` : flat;
}

/** What one piece of a result costs: its serialized form, plus a token for the separator that joins it to the rest. */
function costOf(value: unknown): number {
  return estimateTokens(JSON.stringify(value)) + 1;
}

/**
 * The tokens a whole result may still spend. Every piece (headers, file names, each message) is charged as it
 * is added, so the serialized result stays inside the bound however hostile the mail is. Pieces must be charged
 * in the form that is sent, after hidden characters and internal tags are dealt with.
 */
export class TokenBudget {
  #left: number;

  constructor(max: number) {
    this.#left = max;
  }

  get left(): number {
    return this.#left;
  }

  /** Charges a piece the result cannot do without; the budget may go negative, which leaves nothing for the rest. */
  spend(value: unknown): void {
    this.#left -= costOf(value);
  }

  /** Charges the piece only when it fits, and says whether it did. */
  tryAdd(value: unknown): boolean {
    const cost = costOf(value);
    if (cost > this.#left) {
      return false;
    }
    this.#left -= cost;
    return true;
  }
}
