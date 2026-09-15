import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { structuredEditRejection } from '../../../src/core/sandbox/structuredEditRejection';

describe('structuredEditRejection', () => {
  it('formats a rejection as "<tool> rejected <what>: received <received>; expected <expected>."', () => {
    const message = structuredEditRejection({
      tool: 'apply_patch',
      what: 'the patch format',
      received: '"*** Update File: a.ts"',
      expected: 'a Git-format unified diff',
    });
    expect(message).toBe(
      'apply_patch rejected the patch format: received "*** Update File: a.ts"; expected a Git-format unified diff.',
    );
  });

  it('appends an optional hint after the sentence', () => {
    const message = structuredEditRejection({
      tool: 'apply_patch',
      what: 'the patch format',
      received: 'x',
      expected: 'y',
      hint: 'Send a plain Git unified diff instead.',
    });
    expect(message).toBe(
      'apply_patch rejected the patch format: received x; expected y. Send a plain Git unified diff instead.',
    );
  });

  it('omits the trailing space when no hint is given', () => {
    const message = structuredEditRejection({ tool: 't', what: 'w', received: 'r', expected: 'e' });
    expect(message.endsWith('expected e.')).toBe(true);
  });
});

/**
 * Every call site of `structuredEditRejection` in the modules that validate structured-edit
 * tool arguments must supply both a `received` and an `expected` field, so every rejection a
 * model sees states what it sent and what was wanted, not just the rule it broke.
 */
describe('structuredEditRejection call sites carry received and expected', () => {
  const modules = [
    '../../../src/core/sandbox/openaiPatchFormat.ts',
    '../../../src/core/sandbox/structuredEditPaths.ts',
    '../../../src/core/sandbox/Sandbox.ts',
  ];

  function callSites(source: string): string[] {
    const sites: string[] = [];
    const marker = 'structuredEditRejection(';
    let index = source.indexOf(marker);
    while (index !== -1) {
      // Extract the balanced-paren call expression starting at `structuredEditRejection(`.
      let depth = 0;
      let cursor = index + marker.length - 1;
      let end = -1;
      for (; cursor < source.length; cursor += 1) {
        const char = source[cursor];
        if (char === '(') {
          depth += 1;
        } else if (char === ')') {
          depth -= 1;
          if (depth === 0) {
            end = cursor;
            break;
          }
        }
      }
      if (end !== -1) {
        sites.push(source.slice(index, end + 1));
      }
      index = source.indexOf(marker, index + marker.length);
    }
    return sites;
  }

  for (const relativePath of modules) {
    it(`every structuredEditRejection(...) call in ${relativePath} has received and expected`, () => {
      const source = readFileSync(join(__dirname, relativePath), 'utf-8');
      const sites = callSites(source);
      // Sandbox.ts does not call structuredEditRejection directly today (its structured-edit
      // rejections flow through extractStructuredEditPaths / openaiPatchFormat instead); this
      // guard still runs against it so a rejection added there in the future is caught too.
      for (const site of sites) {
        expect(site).toMatch(/received:/u);
        expect(site).toMatch(/expected:/u);
      }
    });
  }

  it('found at least one call site to guard (the guard is not vacuous)', () => {
    const openaiSource = readFileSync(join(__dirname, '../../../src/core/sandbox/openaiPatchFormat.ts'), 'utf-8');
    expect(callSites(openaiSource).length).toBeGreaterThan(0);
    const pathsSource = readFileSync(join(__dirname, '../../../src/core/sandbox/structuredEditPaths.ts'), 'utf-8');
    expect(callSites(pathsSource).length).toBeGreaterThan(0);
  });
});
