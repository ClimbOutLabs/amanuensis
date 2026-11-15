import assert from 'node:assert/strict';
import test from 'node:test';
import { checkHelpPr, isScreenFile, NO_CHANGE_LABEL, SCREEN_CHANGE_MESSAGE } from '../scripts/check-help-pr.mjs';

const CONTAINER = 'packages/trueforge-ui/src/containers/SettingsBuilder/ModelSettings.tsx';
const TOPIC = 'packages/trueforge/guide/topics/first-steps.md';

test('a container change with no topic change fails', () => {
  assert.deepEqual(checkHelpPr({ changedFiles: [CONTAINER, 'README.md'], labels: [] }), {
    ok: false,
    screenFiles: [CONTAINER],
  });
});

test('the label lets a screen change through', () => {
  assert.equal(checkHelpPr({ changedFiles: [CONTAINER], labels: ['bug', NO_CHANGE_LABEL] }).ok, true);
});

test('a screen change with a topic change passes', () => {
  assert.equal(checkHelpPr({ changedFiles: [CONTAINER, TOPIC], labels: [] }).ok, true);
});

test('a screen change with a Tour card change passes', () => {
  const tour = 'packages/trueforge-ui/src/components/tourPrompts.ts';
  assert.equal(checkHelpPr({ changedFiles: ['packages/frontend/src/App.tsx', tour], labels: [] }).ok, true);
});

test('a change that touches no screen passes', () => {
  assert.equal(checkHelpPr({ changedFiles: ['packages/trueforge/src/help/healthCheck.ts'], labels: [] }).ok, true);
});

test('the screens are the UI, the frontend, the routes and the installer text', () => {
  for (const file of [
    'packages/trueforge-ui/src/atoms/PageHeader.tsx',
    'packages/frontend/src/App.tsx',
    'packages/trueforge/src/routes/helpRoutes.ts',
    'packages/aman-installer/src/messages.ts',
    'installer/lib/email.sh',
  ]) {
    assert.ok(isScreenFile(file), file);
  }
  for (const file of [
    'installer/lib/sub/x.sh',
    'packages/aman-installer/src/cli.ts',
    'packages/trueforge-ui/src/help/helpModel.ts',
  ]) {
    assert.ok(!isScreenFile(file), file);
  }
});

test('the failure says what to do and names the label', () => {
  assert.equal(
    SCREEN_CHANGE_MESSAGE,
    'This change touches a screen people see. Update the help topic that covers it, or add the label `help: no change needed` with a line in the PR saying why.',
  );
});
