import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  baseImageFrom,
  controlVolumeName,
  FIX_COMMAND,
  parseArguments,
  summarizeReport,
  testImageDockerfile,
  testImageTag,
  throwawayContainerArguments,
} from '../scripts/slots-live.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'slots-live.mjs');

describe('arguments', () => {
  it('defaults to the main instance and takes --instance', () => {
    assert.deepEqual(parseArguments([]), { instance: 'main' });
    assert.deepEqual(parseArguments(['--instance', 'demo']), { instance: 'demo' });
    assert.deepEqual(parseArguments(['--', '--instance=demo-2']), { instance: 'demo-2' });
  });

  it('refuses a name that could not be an instance and anything it does not know', () => {
    assert.match(parseArguments(['--instance', 'Main; rm -rf']).problem, /1 to 24 lowercase letters/);
    assert.match(parseArguments(['--instance']).problem, /1 to 24 lowercase letters/);
    assert.match(parseArguments(['--verbose']).problem, /Unknown argument --verbose/);
  });
});

describe('the throwaway container', () => {
  const dockerfile = [
    'ARG NODE_IMAGE=node:24-bookworm-slim@sha256:aaa',
    'ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:bbb',
    'FROM ${NODE_IMAGE} AS node',
  ].join('\n');

  it('uses the base images the slot image is built from', () => {
    assert.equal(
      baseImageFrom({ dockerfileText: dockerfile, argument: 'NODE_IMAGE' }),
      'node:24-bookworm-slim@sha256:aaa',
    );
    assert.equal(baseImageFrom({ dockerfileText: dockerfile, argument: 'UBUNTU_IMAGE' }), 'ubuntu:24.04@sha256:bbb');
    assert.equal(baseImageFrom({ dockerfileText: dockerfile, argument: 'MISSING' }), undefined);
  });

  it('builds the test image from those images, installing the drawing tools inside it', () => {
    const recipe = testImageDockerfile({ nodeImage: 'node:24@sha256:aaa', ubuntuImage: 'ubuntu:24.04@sha256:bbb' });
    assert.match(recipe, /^FROM node:24@sha256:aaa AS node$/m);
    assert.match(recipe, /^FROM ubuntu:24.04@sha256:bbb$/m);
    assert.match(recipe, /apt-get install .*python3 python3-pil libraqm0 fonts-dejavu-core fonts-unifont/);
  });

  it('names the image by its recipe, so a changed recipe is built again', () => {
    assert.match(testImageTag('a'), /^aman-slots-live:[0-9a-f]{12}$/);
    assert.notEqual(testImageTag('a'), testImageTag('b'));
    assert.equal(testImageTag('a'), testImageTag('a'));
  });

  it("mounts the instance's control volumes read-only where the tests look for them, and the checkout at its own path", () => {
    const args = throwawayContainerArguments({
      instance: 'demo',
      slotCount: 2,
      checkout: '/home/owner/amanuensis',
      outputDir: '/tmp/out',
      testImage: 'aman-slots-live:abc',
      uid: 1000,
      gid: 1000,
    });
    assert.deepEqual(args.slice(0, 2), ['run', '--rm']);
    assert.ok(args.includes('demo_slot_ctl_1:/run/aman-slots/1:ro'));
    assert.ok(args.includes('demo_slot_ctl_2:/run/aman-slots/2:ro'));
    assert.ok(!args.some(arg => arg.startsWith('demo_slot_ctl_3')));
    assert.ok(args.includes('/home/owner/amanuensis:/home/owner/amanuensis'));
    assert.ok(args.includes('AMAN_SLOTS_TEST_DIR=/run/aman-slots'));
    assert.ok(args.includes('AMAN_SLOTS_TEST_COUNT=2'));
    // The tests run as the person who started them, so the checkout gets no root-owned files.
    assert.ok(args.includes('HOST_UID=1000'));
    assert.match(args.at(-1), /setpriv --reuid="\$HOST_UID"/);
    assert.equal(controlVolumeName({ instance: 'demo', slot: 4 }), 'demo_slot_ctl_4');
  });
});

describe('the report', () => {
  const passed = title => ({ title, status: 'passed', failureMessages: [] });
  const failed = (title, message) => ({ title, status: 'failed', failureMessages: [message] });
  const report = assertionResults => ({ testResults: [{ assertionResults }] });

  it('prints one tick line per case and a pass verdict', () => {
    const summary = summarizeReport(report([passed('first case'), passed('second case')]));
    assert.deepEqual(summary.lines, ['✓ first case', '✓ second case']);
    assert.equal(summary.verdict, 'PASS: 2 of 2 cases read correctly on the sandbox.');
    assert.equal(summary.ok, true);
  });

  it('marks a failed case with ! and its first line, and gives the one fix', () => {
    const summary = summarizeReport(report([passed('ok case'), failed('bad case', 'Error: boom\n    at somewhere')]));
    assert.deepEqual(summary.lines, ['✓ ok case', '! bad case: Error: boom']);
    assert.equal(summary.verdict, `FAIL: 1 of 2 cases did not work. Run \`${FIX_COMMAND}\`, then run this again.`);
    assert.equal(summary.ok, false);
  });

  it('leaves out skipped cases, and is a failure when nothing ran', () => {
    const summary = summarizeReport(report([{ title: 'other describe', status: 'pending', failureMessages: [] }]));
    assert.deepEqual(summary.lines, ['! No attachment cases ran.']);
    assert.equal(summary.ok, false);
  });
});

describe('the command', () => {
  it('stops with one plain line on a bad instance name, before touching Docker', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--instance', 'NOPE'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(result.stderr.trim().split('\n').length, 1);
  });
});
