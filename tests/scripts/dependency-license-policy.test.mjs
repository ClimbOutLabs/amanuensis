/**
 * Self-test for scripts/dependency-license-policy.mjs.
 * Run: pnpm test:licenses
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import spdxExceptionIds from 'spdx-exceptions' with { type: 'json' };
import {
  ACCEPTED_EXCEPTIONS,
  expressionAccepted,
  licenseProblem,
  recognisedLicense,
  reviewedEntryProblem,
} from '../../scripts/dependency-license-policy.mjs';

test('accepted SPDX ids and exact aliases pass', () => {
  for (const license of [
    'MIT',
    'Apache-2.0',
    'BSD-3-Clause',
    'ISC',
    'MPL-2.0',
    'LGPL-3.0-or-later',
    'EPL-2.0',
    'BSD License',
    'MIT License',
  ]) {
    assert.equal(licenseProblem([license]), null, license);
  }
  assert.equal(licenseProblem(['GNU Lesser General Public License v3 (LGPLv3)']), null);
});

test('copyleft, source-available, proprietary and unknown licenses fail', () => {
  for (const license of [
    'GPL-3.0-only',
    'GPL-2.0-or-later',
    'AGPL-3.0',
    'SSPL-1.0',
    'EUPL-1.2',
    'CC-BY-SA-4.0',
    'GNU General Public License v2 or later (GPLv2+)',
    'BUSL-1.1',
    'Elastic-2.0',
    'CC-BY-NC-4.0',
    'UNLICENSED',
    'SEE LICENSE IN LICENSE.md',
    'Proprietary',
    'LicenseRef-Commercial',
    'MIT-like',
  ]) {
    assert.match(licenseProblem([license]) ?? '', /not on the accepted list/, license);
  }
});

test('a package with no license fails', () => {
  assert.equal(licenseProblem([]), 'declares no license');
  assert.equal(licenseProblem(['  ']), 'declares no license');
});

test('an OR passes when any branch passes; an AND needs every part', () => {
  assert.equal(expressionAccepted('(MIT OR GPL-3.0-or-later)'), true);
  assert.equal(expressionAccepted('BSD-3-Clause OR GPL-2.0'), true);
  assert.equal(expressionAccepted('MIT AND GPL-2.0-only'), false);
  assert.equal(expressionAccepted('(GPL-2.0-only OR AGPL-3.0-only) AND MIT'), false);
  assert.equal(expressionAccepted('Apache-2.0 WITH LLVM-exception'), true);
  assert.equal(expressionAccepted('GPL-2.0-only WITH Classpath-exception-2.0'), false);
});

test('an exception passes only when it is on the accepted exception list', () => {
  assert.equal(expressionAccepted('Apache-2.0 WITH LLVM-exception'), true);
  assert.equal(expressionAccepted('MIT WITH Linux-syscall-note'), true);
  assert.equal(expressionAccepted('Apache-2.0 WITH Commons-Clause'), false);
  assert.equal(expressionAccepted('MIT WITH Anything-Goes'), false);
  assert.equal(expressionAccepted('(MIT WITH Anything-Goes) OR GPL-3.0-only'), false);
  assert.equal(expressionAccepted('MIT WITH'), false);
  assert.equal(expressionAccepted('MIT WITH AND Apache-2.0'), false);
});

test('every accepted exception is a real SPDX exception id', () => {
  const known = new Set(spdxExceptionIds);
  for (const exception of ACCEPTED_EXCEPTIONS) {
    assert.ok(known.has(exception), exception);
  }
});

test('trove classifiers are judged by the license they name', () => {
  assert.equal(licenseProblem(['License :: OSI Approved :: MIT License']), null);
  assert.match(
    licenseProblem(['License :: OSI Approved :: GNU General Public License v3 (GPLv3)']) ?? '',
    /not on the accepted list/,
  );
});

test('known licenses are recognised, accepted or not', () => {
  for (const statement of [
    'MIT',
    'GPL-3.0-only',
    'GPL-2.0+',
    'Apache-2.0 WITH LLVM-exception',
    'MIT OR AGPL-3.0-only',
    'License :: OSI Approved :: GNU General Public License v3 (GPLv3)',
    'UNLICENSED',
    'GPL',
    'GNU Affero General Public License',
    'Business Source License 1.1',
    'Proprietary',
  ]) {
    assert.equal(recognisedLicense(statement), true, statement);
  }
  for (const statement of ['MIT-like', 'SEE LICENSE IN LICENSE.md', 'LicenseRef-Custom', 'Dual License', 'Unknown']) {
    assert.equal(recognisedLicense(statement), false, statement);
  }
});

test('a reviewed entry may only fill in missing or unrecognised metadata', () => {
  assert.equal(reviewedEntryProblem([]), null);
  assert.equal(reviewedEntryProblem(['MIT-like']), null);
  assert.equal(reviewedEntryProblem(['BSD-3-Clause, Apache-2.0, dependency licenses']), null);
  assert.match(reviewedEntryProblem(['GPL-3.0-only']) ?? '', /already names a license \(GPL-3\.0-only\)/);
  assert.match(reviewedEntryProblem(['MIT']) ?? '', /already names a license/);
  assert.match(reviewedEntryProblem(['MIT-like', 'AGPL-3.0-only']) ?? '', /AGPL-3\.0-only/);
});

test('malformed expressions fail', () => {
  for (const expression of ['MIT OR', '(MIT', 'MIT)', 'AND MIT', 'MIT, Apache-2.0', '']) {
    assert.equal(expressionAccepted(expression), false, expression);
  }
});

test('every license statement must pass', () => {
  assert.match(licenseProblem(['MIT', 'GNU General Public License v3 (GPLv3)']) ?? '', /GPLv3/);
});
