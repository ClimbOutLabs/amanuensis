/**
 * Self-test for scripts/dependency-license-policy.mjs.
 * Run: pnpm test:licenses
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { licenseProblem, unavoidableCopyleft } from '../../scripts/dependency-license-policy.mjs';

const declared = (...licenses) => licenseProblem({ declared: licenses, shippedText: null });

test('permissive and weak copyleft licenses pass', () => {
  for (const license of [
    'MIT',
    'Apache-2.0',
    'BSD-3-Clause',
    'ISC',
    'MPL-2.0',
    'LGPL-3.0-or-later',
    'EPL-2.0',
    'BSD License',
  ]) {
    assert.equal(declared(license), null, license);
  }
  assert.equal(declared('GNU Lesser General Public License v3 (LGPLv3)'), null);
  assert.equal(declared('GNU Library or Lesser General Public License (LGPL)'), null);
});

test('strong and network copyleft licenses fail', () => {
  for (const license of [
    'GPL-3.0-only',
    'GPL-2.0-or-later',
    'GPLv3',
    'AGPL-3.0',
    'SSPL-1.0',
    'EUPL-1.2',
    'OSL-3.0',
    'CC-BY-SA-4.0',
    'GNU General Public License v2 or later (GPLv2+)',
    'GNU Affero General Public License v3',
  ]) {
    assert.match(declared(license) ?? '', /uses a .* license/, license);
  }
});

test('an OR is clean when any branch is clean; an AND needs every part clean', () => {
  assert.deepEqual(unavoidableCopyleft('(MIT OR GPL-3.0-or-later)'), []);
  assert.deepEqual(unavoidableCopyleft('BSD-3-Clause OR GPL-2.0'), []);
  assert.deepEqual(unavoidableCopyleft('MIT AND GPL-2.0-only'), ['GPL / AGPL']);
  assert.deepEqual(unavoidableCopyleft('(GPL-2.0-only OR AGPL-3.0-only) AND MIT'), ['GPL / AGPL']);
  assert.deepEqual(unavoidableCopyleft('GPL-2.0-only WITH Classpath-exception-2.0'), ['GPL / AGPL']);
});

test('every declared statement must be clean', () => {
  assert.match(declared('MIT', 'GNU General Public License v3 (GPLv3)') ?? '', /GPL/);
});

test('an undeclared package is judged by the text it ships', () => {
  assert.equal(licenseProblem({ declared: [], shippedText: '# curry\nA tiny helper.' }), null);
  assert.match(licenseProblem({ declared: [], shippedText: 'Licensed under the GNU GPL v3.' }) ?? '', /mentions GPL/);
  assert.match(licenseProblem({ declared: [''], shippedText: null }) ?? '', /declares no license and ships no text/);
});
