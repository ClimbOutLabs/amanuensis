import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NoFreePortError,
  firstInstallArgs,
  pickInstallPorts,
  starterInstallArgs,
} from '../../src/host/windowsInstall.ts';

function held(...ports: number[]): (port: number) => Promise<boolean> {
  const set = new Set(ports);
  return (port: number) => Promise.resolve(!set.has(port));
}

test('with nothing held, the first pair and the https port are picked', async () => {
  const picks = await pickInstallPorts({ isFree: held() });
  assert.deepEqual(picks, { appPort: 8791, loginPort: 5556, tlsPort: 8443 });
});

test('a held app port moves the app pick to the next free one', async () => {
  const picks = await pickInstallPorts({ isFree: held(8791) });
  assert.deepEqual(picks, { appPort: 8792, loginPort: 5556, tlsPort: 8443 });
});

test('a held sign-in port moves the sign-in pick to the next free one', async () => {
  const picks = await pickInstallPorts({ isFree: held(5556) });
  assert.deepEqual(picks, { appPort: 8791, loginPort: 5557, tlsPort: 8443 });
});

test('both first ports held moves the pair together', async () => {
  const picks = await pickInstallPorts({ isFree: held(8791, 5556) });
  assert.deepEqual(picks, { appPort: 8792, loginPort: 5557, tlsPort: 8443 });
});

test("the installer's own kept ports are never picked, even when free", async () => {
  // 5558 is free on the computer but kept by the installer itself, so
  // the sign-in pick steps over it.
  const picks = await pickInstallPorts({ isFree: held(5556, 5557) });
  assert.equal(picks.loginPort, 5559);
});

test('a held https port moves its pick up', async () => {
  const picks = await pickInstallPorts({ isFree: held(8443, 8444) });
  assert.equal(picks.tlsPort, 8445);
});

test('when no port is free the pick fails instead of guessing', async () => {
  await assert.rejects(pickInstallPorts({ isFree: () => Promise.resolve(false) }), NoFreePortError);
});

test("the starter's command line with the first pair carries no port flags", () => {
  assert.deepEqual(starterInstallArgs({ email: 'friend@example.com', appPort: 8791, loginPort: 5556 }), [
    'installer/install.sh',
    '--yes',
    '--local-only',
    '--backups',
    'off',
    '--name',
    'main',
    '--email',
    'friend@example.com',
    '--password-stdin',
    '--token-factory-key-stdin',
  ]);
});

test("the starter's command line with a moved pair hands both ports over", () => {
  assert.deepEqual(starterInstallArgs({ email: 'friend@example.com', appPort: 8792, loginPort: 5557 }), [
    'installer/install.sh',
    '--yes',
    '--local-only',
    '--backups',
    'off',
    '--name',
    'main',
    '--email',
    'friend@example.com',
    '--password-stdin',
    '--token-factory-key-stdin',
    '--port',
    '8792',
    '--login-port',
    '5557',
  ]);
});

test('a pair moved on the sign-in side only still hands both ports over', () => {
  const args = starterInstallArgs({ email: 'friend@example.com', appPort: 8791, loginPort: 5559 });
  assert.deepEqual(args.slice(-4), ['--port', '8791', '--login-port', '5559']);
});

test('the first install line adds https on this computer and daily backups to the starter line', () => {
  assert.deepEqual(firstInstallArgs({ email: 'friend@example.com', appPort: 8791, loginPort: 5556, hasKey: true }), [
    'installer/install.sh',
    '--yes',
    '--name',
    'main',
    '--email',
    'friend@example.com',
    '--password-stdin',
    '--token-factory-key-stdin',
    '--tls',
    'local',
    '--address',
    'localhost',
    '--backups',
    'daily',
  ]);
});

test('the first install line with no key given asks for no key on the input', () => {
  const args = firstInstallArgs({ email: 'friend@example.com', appPort: 8791, loginPort: 5556, hasKey: false });
  assert.ok(!args.includes('--token-factory-key-stdin'));
  assert.ok(!args.includes('--local-only'));
});

test('the first install line with a moved pair hands both ports over', () => {
  const args = firstInstallArgs({ email: 'friend@example.com', appPort: 8792, loginPort: 5556, hasKey: false });
  assert.deepEqual(args.slice(-4), ['--port', '8792', '--login-port', '5556']);
});
