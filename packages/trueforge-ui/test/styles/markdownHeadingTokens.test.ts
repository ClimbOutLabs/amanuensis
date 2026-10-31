import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the chat thread's markdown heading sizes against drifting back to a one-off
 * literal: h1/h2 must stay on the thread's own --text-2xl / --text-xl scale steps.
 */
describe('chat markdown heading sizes', () => {
  const cssPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'github-markdown-bridge.css');
  const css = readFileSync(cssPath, 'utf8');

  const ruleOf = (selector: string): string => {
    const start = css.indexOf(`\n${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf('}', start) + 1);
  };

  it('sizes the chat thread h1 and h2 on the scale, not a one-off literal', () => {
    expect(ruleOf('.aui-markdown.markdown-body h1')).toMatch(/font-size: var\(--text-2xl\);/);
    expect(ruleOf('.aui-markdown.markdown-body h2')).toMatch(/font-size: var\(--text-xl\);/);
  });
});
