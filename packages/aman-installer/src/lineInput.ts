import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

export interface LineInput {
  // The next line, or null once the input has ended.
  next: () => Promise<string | null>;
  close: () => void;
}

// Reads answers a line at a time. One reader serves every question of a
// piped input: a reader per question takes in every line that has
// arrived, and the lines after the first are lost with it. The end of
// the input answers a waiting question with null, so a question asked
// of an empty input ends instead of waiting for ever.
export function createLineInput(input: Readable): LineInput {
  const ready: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;
  const reader = createInterface({ input, crlfDelay: Infinity });
  reader.on('line', line => {
    const answer = waiting.shift();
    if (answer === undefined) {
      ready.push(line);
    } else {
      answer(line);
    }
  });
  reader.on('close', () => {
    ended = true;
    for (const answer of waiting.splice(0)) {
      answer(null);
    }
  });
  return {
    next: () => {
      const line = ready.shift();
      if (line !== undefined) {
        return Promise.resolve(line);
      }
      if (ended) {
        return Promise.resolve(null);
      }
      return new Promise(resolve => {
        waiting.push(resolve);
      });
    },
    close: () => {
      reader.close();
    },
  };
}
