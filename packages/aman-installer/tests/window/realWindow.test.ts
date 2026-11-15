import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  problemText,
  WINDOW_ABOUT_TITLE,
  WINDOW_CLOSED_EARLY,
  WINDOW_DONE_TITLE,
  WINDOW_RULE_LABELS,
  WINDOW_WELCOME_TITLE,
} from '../../src/messages.ts';
import { openSetupWindow, type WindowLaunch } from '../../src/window/launch.ts';
import type { ToWindow } from '../../src/window/protocol.ts';
import { runWindowInstall } from '../../src/window/session.ts';
import { WINDOW_BOOTSTRAP } from '../../src/window/windowScript.ts';
import { makeWorld } from '../commands/installWorld.ts';

// These tests open the real setup window, so they run on Windows
// only, where a person (the driver script) can use it.
const onWindows = process.platform === 'win32';
const DRIVER = fileURLToPath(new URL('./uiDriver.ps1', import.meta.url));
// A password with a letter outside English, to prove the bytes that
// reach the installer are UTF-8.
const CANARY = 'Zürich-Canary7!';
const EMAIL = 'friend@example.com';

type Screen = Extract<ToWindow, { t: 'screen' }>;

function drive(steps: readonly string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DRIVER, ...steps],
      { timeout: 120000 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`the driver failed: ${stderr}`, { cause: error }));
          return;
        }
        resolve(stdout.split(/\r?\n/).filter(line => line !== ''));
      },
    );
  });
}

function launch(): WindowLaunch {
  const opened = openSetupWindow({ systemRoot: process.env['SystemRoot'], env: process.env });
  assert.ok(opened !== null, 'the setup window could not be started');
  return opened;
}

// Joins a person to the window: each screen that waits for the person
// is answered by the steps the test gives for it, one screen at a time.
function withPerson(
  opened: WindowLaunch,
  answer: (screen: Screen) => readonly string[] | null,
): { launch: WindowLaunch; seen: string[]; failures: unknown[] } {
  const seen: string[] = [];
  const failures: unknown[] = [];
  let chain: Promise<void> = Promise.resolve();
  const channel = {
    ...opened.channel,
    send: (message: ToWindow): void => {
      opened.channel.send(message);
      if (message.t !== 'screen' || message.next === null) {
        return;
      }
      const steps = answer(message);
      if (steps === null) {
        return;
      }
      chain = chain
        .then(() => drive(steps))
        .then(lines => {
          seen.push(...lines);
        })
        .catch((error: unknown) => {
          failures.push(error);
          opened.channel.close();
        });
    },
  };
  return { launch: { ...opened, channel }, seen, failures };
}

function forward(screen: Screen): readonly string[] {
  if (screen.name === 'welcome') {
    return ['read:Title', 'click:NextButton'];
  }
  if (screen.name === 'about') {
    return [
      'read:Title',
      `set:EmailBox:${EMAIL}`,
      `set:PassBox:${CANARY}`,
      `set:AgainBox:${CANARY}`,
      'read:Rule0',
      'read:Rule1',
      'read:Rule2',
      'read:Rule3',
      `commandlines:${String(process.pid)}`,
      'click:NextButton',
    ];
  }
  if (screen.name === 'options') {
    return ['select:PhoneNo', 'click:NextButton'];
  }
  if (screen.name === 'done') {
    return ['read:Title', 'click:NextButton'];
  }
  return ['click:NextButton'];
}

test(
  'a person walks the real window from Welcome to Done and the password reaches the installer as UTF-8',
  { skip: !onWindows, timeout: 300000 },
  async () => {
    const world = await makeWorld();
    const person = withPerson(launch(), forward);
    const outcome = await runWindowInstall(world.deps, person.launch);
    assert.deepEqual(person.failures, []);
    assert.deepEqual(outcome, { kind: 'finished', code: 0 });
    const run = world.runner.installRuns[0];
    assert.ok(run !== undefined);
    assert.deepEqual([...run.stdin], [...new TextEncoder().encode(`${CANARY}\n`)]);
    assert.ok(run.args.includes(EMAIL));
    assert.equal(world.jobs.firewallOpen, false);
    const check = String.fromCharCode(0x2713);
    assert.ok(person.seen.includes(`Title=${WINDOW_WELCOME_TITLE}`), person.seen.join('\n'));
    assert.ok(person.seen.includes(`Title=${WINDOW_ABOUT_TITLE}`));
    assert.ok(person.seen.includes(`Title=${WINDOW_DONE_TITLE}`));
    // Every part of the password rule was ticked off as it was typed.
    for (const [index, label] of WINDOW_RULE_LABELS.entries()) {
      assert.ok(person.seen.includes(`Rule${String(index)}=${check}  ${label}`), person.seen.join('\n'));
    }
    // The window's process was started with the fixed words only: nothing typed is on its command line.
    const commandLines = person.seen.filter(
      line => line.startsWith('commandline=') && line.includes('-InputFormat None'),
    );
    assert.equal(commandLines.length, 1, person.seen.join('\n'));
    assert.ok(commandLines[0]?.includes(WINDOW_BOOTSTRAP.slice(0, 60)));
    assert.ok(!person.seen.join('\n').includes(CANARY));
    assert.ok(!commandLines.join('\n').includes(EMAIL));
    // Nothing printed or run holds the password.
    assert.ok(!world.printed.join('\n').includes(CANARY));
    assert.ok(!world.recording.lines().join('\n').includes(CANARY));
  },
);

test(
  'closing the real window on Welcome ends the setup and installs nothing',
  { skip: !onWindows, timeout: 300000 },
  async () => {
    const world = await makeWorld();
    const person = withPerson(launch(), screen => (screen.name === 'welcome' ? ['close'] : null));
    const outcome = await runWindowInstall(world.deps, person.launch);
    assert.deepEqual(person.failures, []);
    assert.deepEqual(outcome, { kind: 'finished', code: 1 });
    assert.equal(world.printed.at(-1), problemText(WINDOW_CLOSED_EARLY));
    assert.equal(world.runner.installRuns.length, 0);
  },
);

test(
  'passwords that differ are refused in the real window and can be typed again',
  { skip: !onWindows, timeout: 300000 },
  async () => {
    const world = await makeWorld();
    let first = true;
    const person = withPerson(launch(), screen => {
      if (screen.name === 'about' && first) {
        first = false;
        return [
          `set:EmailBox:${EMAIL}`,
          `set:PassBox:${CANARY}`,
          'set:AgainBox:Different-Canary7!',
          'click:NextButton',
          'read:Problem',
          `set:PassBox:${CANARY}`,
          `set:AgainBox:${CANARY}`,
          'click:NextButton',
        ];
      }
      return forward(screen);
    });
    const outcome = await runWindowInstall(world.deps, person.launch);
    assert.deepEqual(person.failures, []);
    assert.deepEqual(outcome, { kind: 'finished', code: 0 });
    assert.ok(person.seen.includes('Problem=The passwords do not match. Type them again.'), person.seen.join('\n'));
    assert.deepEqual([...(world.runner.installRuns[0]?.stdin ?? [])], [...new TextEncoder().encode(`${CANARY}\n`)]);
  },
);
