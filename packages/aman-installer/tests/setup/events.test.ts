import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseEventLine, parseEvents, progressFromEvents } from '../../src/setup/events.ts';

// The lines below are the stream of a real run, in the shapes
// installer/lib/ui.sh writes (a stubbed full install and a bare dry
// run): the shapes are the contract, so they are pinned here as they
// were captured.
const FULL_RUN = [
  '{"type":"phase_start","name":"Checking this computer","index":1,"total":6,"elapsed_seconds":0}',
  '{"type":"step_result","name":"Linux on x86_64","result":"done","phase":"Checking this computer","elapsed_seconds":0}',
  '{"type":"phase_start","name":"Building the app","index":4,"total":6,"elapsed_seconds":0}',
  '{"type":"step_start","name":"Building the Aman app (this might take a while)","phase":"Building the app","elapsed_seconds":0}',
  '{"type":"admin_prompt","text":"Preparing the sandbox needs administrator rights on this computer.","elapsed_seconds":1}',
  '{"type":"step_result","name":"Built the Aman app","result":"done","phase":"Building the app","elapsed_seconds":2}',
  '{"type":"warning","text":"The sandbox slots are not running yet.","next":"Run aman doctor.","elapsed_seconds":2}',
  '{"type":"final_result","result":"success","verdict_kind":"ok","verdict":"Ready. Instance main is running.","elapsed_seconds":3}',
].join('\n');

test('a step result pairs with the latest start before it, by position', () => {
  const progress = progressFromEvents(parseEvents(FULL_RUN));
  const building = progress.phases.find(phase => phase.name === 'Building the app');
  assert.ok(building !== undefined);
  assert.equal(building.steps.length, 1);
  assert.equal(building.steps[0]?.startName, 'Building the Aman app (this might take a while)');
  assert.equal(building.steps[0]?.resultName, 'Built the Aman app');
  assert.equal(building.steps[0]?.result, 'done');
});

test('a result with no start before it stands as its own step', () => {
  const progress = progressFromEvents(parseEvents(FULL_RUN));
  const checks = progress.phases.find(phase => phase.name === 'Checking this computer');
  assert.ok(checks !== undefined);
  assert.equal(checks.steps.length, 1);
  assert.equal(checks.steps[0]?.result, 'done');
});

test('the admin prompt stands until the next step closes, then clears', () => {
  const events = parseEvents(FULL_RUN);
  const during = progressFromEvents(events.slice(0, 5));
  assert.equal(during.adminPrompt, 'Preparing the sandbox needs administrator rights on this computer.');
  const after = progressFromEvents(events);
  assert.equal(after.adminPrompt, null);
});

test('warnings and the final result fold in', () => {
  const progress = progressFromEvents(parseEvents(FULL_RUN));
  assert.deepEqual(progress.warnings, [{ text: 'The sandbox slots are not running yet.', next: 'Run aman doctor.' }]);
  assert.equal(progress.final?.result, 'success');
  assert.equal(progress.final?.verdictKind, 'ok');
  assert.equal(progress.final?.verdict, 'Ready. Instance main is running.');
  assert.equal(progress.elapsedSeconds, 3);
});

test('a closing warn keeps its kind, for the Done screen warning', () => {
  const events = parseEvents(
    '{"type":"final_result","result":"success","step":"Check the result","phase":"Checking the result","verdict_kind":"warn","verdict":"Running, but the checks found a problem (listed above).","elapsed_seconds":9}',
  );
  const progress = progressFromEvents(events);
  assert.equal(progress.final?.verdictKind, 'warn');
});

test('lines that are not events are passed over', () => {
  assert.equal(parseEventLine('not json'), null);
  assert.equal(parseEventLine('{"type":"mystery"}'), null);
  assert.equal(parseEventLine('{"type":"step_result","name":"x","result":"maybe"}'), null);
  assert.equal(parseEventLine('42'), null);
  assert.deepEqual(parseEvents('\n\n'), []);
});
