// Shared by the test mailbox scripts: both read settings from environment
// variables first, then from a gitignored `.env.test-mailbox` file, and both
// deliver only the messages listed in demo-set.json.

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const defaultFixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mailbox');

export function parseEnvFile(text) {
  const values = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function loadDemoSet({ fixtureDir = defaultFixtureDir } = {}) {
  const manifest = JSON.parse(readFileSync(path.join(fixtureDir, 'demo-set.json'), 'utf8'));
  return manifest.files.map(({ file, language }) => {
    const raw = readFileSync(path.join(fixtureDir, file));
    const header = name => {
      const match = new RegExp(`^${name}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)`, 'im').exec(raw.toString('latin1'));
      return match === null ? '' : match[1].replace(/\r?\n[ \t]+/g, ' ').trim();
    };
    return {
      file,
      language,
      raw,
      messageId: header('Message-ID'),
      date: header('Date'),
      subject: decodeHeaderWords(header('Subject')),
    };
  });
}

// Enough RFC 2047 decoding to show readable subjects in the summary.
function decodeHeaderWords(value) {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, encoding, text) => {
      const bytes =
        encoding.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text
                .replace(/_/g, ' ')
                .replace(/=([0-9A-Fa-f]{2})/g, (__, hex) => String.fromCharCode(parseInt(hex, 16))),
              'latin1',
            );
      return new TextDecoder(charset).decode(bytes);
    });
}
