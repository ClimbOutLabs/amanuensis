import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { URL } from 'node:url';

// A core pin names cores by number, and Docker refuses to start a container whose cores the host lacks, so
// a pin in a checked-in compose file stops the stack on smaller computers. Pins go in a person's own
// docker-compose.override.yml instead.
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.dev.yml'];

function pinnedLines(text) {
  return text
    .split('\n')
    .map((line, index) => ({ line: line.replace(/#.*$/, ''), number: index + 1 }))
    .filter(({ line }) => /^\s*(cpuset|cpuset_cpus|cpuset_mems)\s*:/.test(line));
}

describe('the checked-in compose files', () => {
  for (const file of COMPOSE_FILES) {
    it(`${file} pins no service to cores`, () => {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const found = pinnedLines(text).map(({ number }) => `${file}:${String(number)}`);
      assert.deepEqual(found, [], 'Move core pins to docker-compose.override.yml (see docs/voice-input.mdx).');
    });
  }

  it('finds a pin when one is there, and skips one in a comment', () => {
    assert.equal(pinnedLines("services:\n  a:\n    cpuset: '0-3'\n").length, 1);
    assert.equal(pinnedLines("services:\n  a:\n    # cpuset: '0-3'\n").length, 0);
  });
});
