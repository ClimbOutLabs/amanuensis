/**
 * Cuts a reply into sentences while it is still streaming in, so the first one can be spoken
 * before the model has finished. A sentence is complete once the character after its stop arrives.
 * Fenced code is never read aloud.
 */
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'no']);

function endsInAbbreviation(text: string): boolean {
  const word = /([A-Za-z.]+)\.$/.exec(text)?.[1]?.toLowerCase();
  return word !== undefined && ABBREVIATIONS.has(word);
}

export class SentenceSplitter {
  #pending = '';
  #inFence = false;

  /** Adds streamed text and returns the sentences it completed. */
  push(text: string): string[] {
    this.#pending += text;
    return this.#drain(false);
  }

  /** The reply is over: whatever is left is the last sentence. */
  flush(): string[] {
    return this.#drain(true);
  }

  #drain(final: boolean): string[] {
    const sentences: string[] = [];
    for (;;) {
      const cut = this.#nextCut(final);
      if (cut === undefined) {
        break;
      }
      const piece = this.#pending.slice(0, cut);
      this.#pending = this.#pending.slice(cut);
      const spoken = this.#spoken(piece);
      if (spoken !== '') {
        sentences.push(spoken);
      }
    }
    return sentences;
  }

  /** Where the next sentence ends, or undefined while it is still being written. */
  #nextCut(final: boolean): number | undefined {
    const text = this.#pending;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (char === '\n') {
        return i + 1;
      }
      if (char === '.' || char === '!' || char === '?' || char === '…') {
        const next = text[i + 1];
        if (next === undefined) {
          if (final) {
            return i + 1;
          }
          return undefined;
        }
        if (/\s/.test(next) && !endsInAbbreviation(text.slice(0, i + 1))) {
          return i + 1;
        }
      }
    }
    return final && text.trim() !== '' ? text.length : undefined;
  }

  /** The words of one piece, with code fences and list or heading marks taken out. */
  #spoken(piece: string): string {
    const trimmed = piece.trim();
    if (trimmed.startsWith('```')) {
      this.#inFence = !this.#inFence;
      return '';
    }
    if (this.#inFence) {
      return '';
    }
    const plain = trimmed.replace(/^(?:[-*+>]\s+|#{1,6}\s+|\d+[.)]\s+)/, '').trim();
    return /[\p{L}\p{N}]/u.test(plain) ? plain : '';
  }
}
