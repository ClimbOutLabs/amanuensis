import { execFileSync } from 'node:child_process';
import path from 'node:path';

const VOICE_SERVICE_DIR = path.resolve(__dirname, '../../../../../ops/aman-tts');

const SCRIPT = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'from phonemes import reads_as_written',
  'print(json.dumps([reads_as_written(text) for text in json.load(sys.stdin)]))',
].join('\n');

function isBooleanList(value: unknown): value is boolean[] {
  return Array.isArray(value) && value.every(item => typeof item === 'boolean');
}

/** What the voice service's own check says for each text: the same code that judges a read-back before it is spoken. */
export function readsAsWritten(texts: string[]): boolean[] {
  const answer: unknown = JSON.parse(
    execFileSync('python3', ['-I', '-c', SCRIPT, VOICE_SERVICE_DIR], {
      input: JSON.stringify(texts),
      encoding: 'utf8',
    }),
  );
  if (!isBooleanList(answer) || answer.length !== texts.length) {
    throw new Error('the voice check answered in an unexpected shape');
  }
  return answer;
}
