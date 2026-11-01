import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkRows } from '../../src/setup/checks.ts';
import { parseEvents } from '../../src/setup/events.ts';

const PASS_RUN = [
  '{"type":"phase_start","name":"Checking this computer","index":1,"total":6,"elapsed_seconds":0}',
  '{"type":"step_result","name":"Linux on x86_64","result":"done","phase":"Checking this computer","elapsed_seconds":0}',
  '{"type":"step_result","name":"Docker is answering: Engine 29.1.3, Compose v2.40.3","result":"done","phase":"Checking this computer","elapsed_seconds":0}',
  '{"type":"step_result","name":"10 GB free on the disk for this folder (22 GB free)","result":"done","phase":"Checking this computer","elapsed_seconds":0}',
  '{"type":"step_result","name":"The summary","result":"skipped","phase":"Checking this computer","elapsed_seconds":0}',
  '{"type":"phase_start","name":"Your first instance","index":2,"total":2,"elapsed_seconds":0}',
  '{"type":"final_result","result":"success","verdict_kind":"ok","verdict":"A dry run: only the plan above was printed.","elapsed_seconds":0}',
].join('\n');

test('a passing preflight reads as passes and does not block', () => {
  const result = checkRows({ events: parseEvents(PASS_RUN), runFailed: false, hostKind: 'linux', finalVerdict: null });
  assert.equal(result.blocked, false);
  assert.equal(result.dockerInstallOffered, false);
  assert.deepEqual(
    result.rows.map(row => row.state),
    ['pass', 'pass', 'pass', 'note'],
  );
});

test('a warning in a run that ends well is a warning, with its fix', () => {
  const events = parseEvents(
    [
      '{"type":"phase_start","name":"Checking this computer","index":1,"total":6,"elapsed_seconds":0}',
      '{"type":"warning","text":"Docker has 6.5 GB of memory, under the 8 GB that suits Aman best.","next":"Raise it in the Docker settings.","elapsed_seconds":0}',
      '{"type":"final_result","result":"success","verdict_kind":"ok","verdict":"ok","elapsed_seconds":0}',
    ].join('\n'),
  );
  const result = checkRows({ events, runFailed: false, hostKind: 'linux', finalVerdict: null });
  assert.equal(result.blocked, false);
  assert.equal(result.rows[0]?.state, 'warn');
  assert.equal(result.rows[0]?.fix, 'Raise it in the Docker settings.');
});

test('the WSL problem in a stopped run is a block with the WSL fix', () => {
  const events = parseEvents(
    [
      '{"type":"phase_start","name":"Checking this computer","index":1,"total":6,"elapsed_seconds":0}',
      '{"type":"warning","text":"Docker Desktop is not connected to this WSL distro, so Docker did not answer.","next":"Open Docker Desktop and choose Settings, then Resources, then WSL Integration. Turn on this distro, choose Apply & Restart, then run install.sh again.","elapsed_seconds":0}',
      '{"type":"final_result","result":"failed","step":"Checking this computer","phase":"Checking this computer","verdict_kind":"stopped","verdict":"That needs fixing first.","elapsed_seconds":0}',
    ].join('\n'),
  );
  const result = checkRows({ events, runFailed: true, hostKind: 'linux', finalVerdict: null });
  assert.equal(result.blocked, true);
  assert.equal(result.rows[0]?.state, 'block');
  assert.match(result.rows[0]?.fix ?? '', /WSL Integration/);
});

test('Docker missing on Linux offers the install; elsewhere it is a note', () => {
  const lines = [
    '{"type":"phase_start","name":"Checking this computer","index":1,"total":6,"elapsed_seconds":0}',
    '{"type":"step_result","name":"Docker is not installed yet: the plan below includes installing it","result":"skipped","phase":"Checking this computer","elapsed_seconds":0}',
  ].join('\n');
  const linux = checkRows({ events: parseEvents(lines), runFailed: false, hostKind: 'linux', finalVerdict: null });
  assert.equal(linux.dockerInstallOffered, true);
  assert.equal(linux.rows[0]?.state, 'offer');
  assert.equal(linux.blocked, false);
  const mac = checkRows({ events: parseEvents(lines), runFailed: false, hostKind: 'darwin', finalVerdict: null });
  assert.equal(mac.dockerInstallOffered, false);
  assert.equal(mac.rows[0]?.state, 'note');
});

test('a stopped run with no warning row still blocks, in its own words', () => {
  const events = parseEvents(
    '{"type":"phase_start","name":"Checking this computer","index":1,"total":6,"elapsed_seconds":0}',
  );
  const result = checkRows({ events, runFailed: true, hostKind: 'linux', finalVerdict: 'That needs fixing first.' });
  assert.equal(result.blocked, true);
  assert.equal(result.rows[result.rows.length - 1]?.name, 'That needs fixing first.');
});

test('events of later phases are not check rows', () => {
  const result = checkRows({ events: parseEvents(PASS_RUN), runFailed: false, hostKind: 'linux', finalVerdict: null });
  assert.equal(result.rows.length, 4);
});
