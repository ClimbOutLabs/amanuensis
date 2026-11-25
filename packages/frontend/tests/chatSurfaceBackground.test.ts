import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.css'), 'utf8');

function ruleFor(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `no rule for ${selector}`);
  const end = css.indexOf('}', start);
  assert.notEqual(end, -1, `unterminated rule for ${selector}`);
  return css.slice(start, end);
}

test('the chat surface paints one background colour, with no two-colour gradient boundary', () => {
  const rule = ruleFor('.aman-chat-surface');
  assert.match(rule, /background-color:\s*var\(--paper\)/);
  // A gradient between the top and bottom paper values splits the screen into
  // two backgrounds at the gradient stop whenever those values differ.
  assert.doesNotMatch(rule, /linear-gradient/);
});
