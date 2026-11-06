/**
 * Cuts a reply into sentences while it is still streaming in, so the first one can be spoken
 * before the model has finished. A sentence is complete once the character after its stop arrives.
 * Fenced code is never read aloud.
 */
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'etc', 'e.g', 'i.e']);
/** A run of words this long with no stop is cut at a space, so one huge sentence cannot be refused by the voice. */
const MAX_SENTENCE_CHARS = 300;

/** True when the stop at the end of `text` belongs to an abbreviation, or to a list number like "1.". */
function stopIsNotTheEnd({ text, next }: { text: string; next: string }): boolean {
  const word = /([A-Za-z.]+)\.$/.exec(text)?.[1]?.toLowerCase();
  if (word !== undefined && ABBREVIATIONS.has(word)) {
    return true;
  }
  // "No. 5" is a number; "No." alone is an answer.
  if (word === 'no') {
    return /\d/.test(next);
  }
  return /(?:^|\n)\s*\d+\.$/.test(text);
}

export class SentenceSplitter {
  #pending = '';
  #inFence = false;
  /** True while the next piece begins a line, the only place a list or heading mark is one. */
  #atLineStart = true;
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
      const spoken = this.#spoken({ piece, atLineStart: this.#atLineStart });
      this.#atLineStart = piece.endsWith('\n');
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
        const upToStop = text.slice(0, i + 1);
        const after = text.slice(i + 1).trimStart();
        if (/\s/.test(next) && after === '' && !final && /\bno\.$/i.test(upToStop)) {
          // "No." may be "No. 5": the next piece decides.
          return undefined;
        }
        if (/\s/.test(next) && !stopIsNotTheEnd({ text: upToStop, next: after })) {
          return i + 1;
        }
      }
    }
    if (text.length >= MAX_SENTENCE_CHARS) {
      const space = text.lastIndexOf(' ', MAX_SENTENCE_CHARS);
      return space > 0 ? space + 1 : MAX_SENTENCE_CHARS;
    }
    return final && text.trim() !== '' ? text.length : undefined;
  }

  /** The words of one piece, with code fences and list or heading marks taken out. */
  #spoken({ piece, atLineStart }: { piece: string; atLineStart: boolean }): string {
    const trimmed = piece.trim();
    if (trimmed.startsWith('```')) {
      this.#inFence = !this.#inFence;
      return '';
    }
    if (this.#inFence) {
      return '';
    }
    const plain = atLineStart ? trimmed.replace(/^(?:[-*+>]\s+|#{1,6}\s+|\d+[.)]\s+)/, '').trim() : trimmed;
    return /[\p{L}\p{N}]/u.test(plain) ? plain : '';
  }
}
