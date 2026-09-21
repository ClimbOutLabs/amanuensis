import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const mobileCss = css.slice(css.indexOf('@media (max-width: 900px)'));

function ruleBody(selector: string): string {
  const start = mobileCss.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `Expected a mobile ${selector} rule`);
  const bodyStart = mobileCss.indexOf('{', start) + 1;
  const bodyEnd = mobileCss.indexOf('}', bodyStart);
  assert.notEqual(bodyEnd, -1, `Expected ${selector} rule to close`);
  return mobileCss.slice(bodyStart, bodyEnd);
}

function classSpecificity(selector: string): number {
  return selector.match(/\.[\w-]+/g)?.length ?? 0;
}

describe('mobile Aman shell', () => {
  it('keeps the runtime rail in flow so it cannot cover the chat composer', () => {
    assert.match(ruleBody('.aman-shell'), /display:\s*flex/);
    assert.match(ruleBody('.aman-shell'), /flex-direction:\s*column/);

    assert.match(ruleBody('.aman-chat-surface'), /flex:\s*1 1 auto/);
    assert.match(ruleBody('.aman-chat-surface'), /overflow:\s*hidden/);

    const mobileRailSelector = '.aman-shell > .aman-runtime-rail';
    const rail = ruleBody(mobileRailSelector);
    assert.match(rail, /position:\s*static/);
    assert.doesNotMatch(rail, /position:\s*fixed/);
    assert.match(rail, /safe-area-inset-bottom/);
    assert.ok(
      classSpecificity(mobileRailSelector) > classSpecificity('.aman-runtime-rail'),
      'The host mobile rule must outrank the SDK rule that ThemeProvider injects later',
    );
  });
});
