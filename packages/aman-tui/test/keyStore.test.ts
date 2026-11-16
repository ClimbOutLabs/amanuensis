import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  chooseKeyStore,
  CommandFailedError,
  FileKeyStore,
  LinuxSecretStore,
  MacKeychainStore,
  type CommandRunner,
} from '../src/keyStore.js';
import { FAKE_TERMINAL_KEY } from './fakePairingServer.js';

const ADDRESS = 'https://nora.example:8443';

interface RecordedCall {
  file: string;
  args: string[];
  input: string | undefined;
}

function recordingRunner(respond: (call: RecordedCall) => { stdout: string }): {
  run: CommandRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const run: CommandRunner = async (file, args, input) => {
    const call: RecordedCall = { file, args, input };
    calls.push(call);
    return respond(call);
  };
  return { run, calls };
}

const failingRunner: CommandRunner = async () => {
  throw new CommandFailedError('The command did not run.', null);
};

describe('FileKeyStore', () => {
  it('keeps keys in an owner-only file and reads them back', async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'aman-tui-keys-'));
    const store = new FileKeyStore(configDir);
    await store.set({ address: ADDRESS, key: FAKE_TERMINAL_KEY });
    await expect(store.get(ADDRESS)).resolves.toBe(FAKE_TERMINAL_KEY);
    await expect(new FileKeyStore(configDir).get(ADDRESS)).resolves.toBe(FAKE_TERMINAL_KEY);
    const file = path.join(configDir, 'keys.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ [ADDRESS]: FAKE_TERMINAL_KEY });
    await store.delete(ADDRESS);
    await expect(store.get(ADDRESS)).resolves.toBeUndefined();
  });
});

describe('MacKeychainStore', () => {
  it('reads, writes, and deletes through the security tool', async () => {
    const { run, calls } = recordingRunner(call => {
      if (call.args[0] === 'find-generic-password') {
        return { stdout: `${FAKE_TERMINAL_KEY}\n` };
      }
      return { stdout: '' };
    });
    const store = new MacKeychainStore(run);
    await expect(store.get(ADDRESS)).resolves.toBe(FAKE_TERMINAL_KEY);
    await store.set({ address: ADDRESS, key: FAKE_TERMINAL_KEY });
    await store.delete(ADDRESS);
    const setCall = calls.find(call => call.args[0] === 'add-generic-password');
    expect(setCall?.args).toContain('-w');
    expect(setCall?.args).toContain(FAKE_TERMINAL_KEY);
    expect(setCall?.args).toContain(ADDRESS);
  });

  it('reads a missing key as no key', async () => {
    const missing: CommandRunner = async () => {
      throw new CommandFailedError('The command security did not run.', 44);
    };
    const store = new MacKeychainStore(missing);
    await expect(store.get(ADDRESS)).resolves.toBeUndefined();
    await expect(store.delete(ADDRESS)).resolves.toBeUndefined();
  });
});

describe('LinuxSecretStore', () => {
  it('hands the key to secret-tool on stdin, never as an argument', async () => {
    const { run, calls } = recordingRunner(call => {
      if (call.args[0] === 'lookup') {
        return { stdout: FAKE_TERMINAL_KEY };
      }
      return { stdout: '' };
    });
    const store = new LinuxSecretStore(run);
    await store.set({ address: ADDRESS, key: FAKE_TERMINAL_KEY });
    const setCall = calls.find(call => call.args[0] === 'store');
    expect(setCall?.input).toBe(FAKE_TERMINAL_KEY);
    expect(setCall?.args).not.toContain(FAKE_TERMINAL_KEY);
    await expect(store.get(ADDRESS)).resolves.toBe(FAKE_TERMINAL_KEY);
  });

  it('probes false when secret-tool cannot answer', async () => {
    await expect(new LinuxSecretStore(failingRunner).probe()).resolves.toBe(false);
    const { run } = recordingRunner(() => ({ stdout: '' }));
    await expect(new LinuxSecretStore(run).probe()).resolves.toBe(true);
  });
});

describe('chooseKeyStore', () => {
  it('picks the keychain on a Mac', async () => {
    const store = await chooseKeyStore({ configDir: '/unused', platform: 'darwin', run: failingRunner });
    expect(store).toBeInstanceOf(MacKeychainStore);
    expect(store.kind).toBe('keychain');
  });

  it('picks the secret service on Linux when it answers, and the file when it does not', async () => {
    const { run } = recordingRunner(() => ({ stdout: '' }));
    const withService = await chooseKeyStore({ configDir: '/unused', platform: 'linux', run });
    expect(withService).toBeInstanceOf(LinuxSecretStore);
    const withoutService = await chooseKeyStore({ configDir: '/unused', platform: 'linux', run: failingRunner });
    expect(withoutService).toBeInstanceOf(FileKeyStore);
    expect(withoutService.kind).toBe('file');
  });

  it('uses the file store on Windows in this step', async () => {
    const store = await chooseKeyStore({ configDir: '/unused', platform: 'win32', run: failingRunner });
    expect(store).toBeInstanceOf(FileKeyStore);
  });
});
