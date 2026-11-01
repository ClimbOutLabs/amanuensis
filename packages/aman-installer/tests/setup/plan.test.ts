import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePlan } from '../../src/setup/plan.ts';

// A dry run's plan, in the exact printed shape of print_plan in
// installer/lib/plan.sh (markers, state words, the text column,
// wrapped rows, and the verbose download list with sizes).
const DRY_RUN_STDOUT = `Installing Aman on this computer (dry run: nothing will be changed)

Checking this computer

  + Linux on x86_64
  + Docker is answering: Engine 29.1.3, Compose v2.40.3

The plan

  > to do        Create the folder /home/person/.amanuensis for Aman's own files
  > to do        Download the pinned Node.js runtime (about 35 MB from nodejs.org) for the sandbox setup
  ! needs admin  Set up the sandbox on this computer
                 Details: put the sandbox guard file in place and load it, and make a few large empty
                 files the slots run in.
  ✓ done         The plan itself, printed before anything changes
  Steps marked needs admin change this computer and run only after you say yes.

  First-run downloads (approximate):
       700 MB  Ubuntu base image for the app and its helpers (docker.io)
       305 MB  Speech model, large-v3-turbo (built once) (huggingface.co)
    total: about 1005 MB (1.0 GB)
    sources: docker.io, huggingface.co
`;

test('rows come out with their states and their wrapped words joined', () => {
  const plan = parsePlan(DRY_RUN_STDOUT);
  assert.equal(plan.rows.length, 4);
  assert.deepEqual(plan.rows[0], {
    state: 'todo',
    text: "Create the folder /home/person/.amanuensis for Aman's own files",
  });
  assert.deepEqual(plan.rows[2], {
    state: 'admin',
    text: 'Set up the sandbox on this computer Details: put the sandbox guard file in place and load it, and make a few large empty files the slots run in.',
  });
  assert.deepEqual(plan.rows[3], { state: 'done', text: 'The plan itself, printed before anything changes' });
});

test('check lines and hints are not plan rows', () => {
  const plan = parsePlan(DRY_RUN_STDOUT);
  assert.ok(plan.rows.every(row => !row.text.startsWith('Linux on')));
  assert.ok(plan.rows.every(row => !row.text.startsWith('Steps marked')));
});

test('downloads come out with sizes, words and hosts, plus the total', () => {
  const plan = parsePlan(DRY_RUN_STDOUT);
  assert.deepEqual(plan.downloads, [
    { sizeMb: 700, what: 'Ubuntu base image for the app and its helpers', hosts: 'docker.io' },
    { sizeMb: 305, what: 'Speech model, large-v3-turbo (built once)', hosts: 'huggingface.co' },
  ]);
  assert.equal(plan.totalMb, 1005);
});

test('a plan without the verbose downloads parses with none', () => {
  const plan = parsePlan('  > to do        One step\n');
  assert.deepEqual(plan.rows, [{ state: 'todo', text: 'One step' }]);
  assert.deepEqual(plan.downloads, []);
  assert.equal(plan.totalMb, null);
});
