import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileKeyStore } from '../src/keyStore.js';
import { runLogin } from '../src/login.js';
import { PairingRefusedError } from '../src/pairing.js';
import {
  ADDRESS_NOT_LISTED_MESSAGE,
  FAKE_TERMINAL_KEY,
  FakePairingServer,
  PAIRING_GONE_MESSAGE,
} from './fakePairingServer.js';

function modeOf(file: string): number {
  return statSync(file).mode & 0o777;
}

describe('runLogin against a fake Step 1 server', () => {
  let server: FakePairingServer;
  let configDir: string;
  let printed: string[];

  beforeEach(async () => {
    server = new FakePairingServer();
    await server.listen();
    configDir = mkdtempSync(path.join(tmpdir(), 'aman-tui-login-'));
    printed = [];
  });

  afterEach(async () => {
    await server.close();
  });

  function deps() {
    return {
      print: (line: string) => printed.push(line),
      chooseKeyStore: async () => new FileKeyStore(configDir),
      sleep: async () => undefined,
    };
  }

  it('shows the code and the confirm link, saves the key, and never prints the key', async () => {
    const instance = await runLogin({ configDir, addressInput: server.baseUrl, deviceName: 'Pippa', deps: deps() });
    expect(instance).toEqual({ address: server.baseUrl, deviceName: 'Pippa', keyStore: 'file' });

    const shown = printed.join('\n');
    expect(shown).toContain('W X Y Z - 2 3 4 5');
    expect(shown).toContain(`${server.baseUrl}/pair-terminal?code=WXYZ-2345`);
    expect(shown).not.toContain(FAKE_TERMINAL_KEY);

    const store: unknown = JSON.parse(readFileSync(path.join(configDir, 'instances.json'), 'utf8'));
    expect(store).toEqual({
      instances: [{ address: server.baseUrl, deviceName: 'Pippa', keyStore: 'file' }],
      activeAddress: server.baseUrl,
    });
    const keys: unknown = JSON.parse(readFileSync(path.join(configDir, 'keys.json'), 'utf8'));
    expect(keys).toEqual({ [server.baseUrl]: FAKE_TERMINAL_KEY });
    expect(modeOf(path.join(configDir, 'keys.json'))).toBe(0o600);
    expect(modeOf(path.join(configDir, 'instances.json'))).toBe(0o600);
    expect(modeOf(configDir)).toBe(0o700);
  });

  it('saves nothing and shows the server line when the code has expired', async () => {
    const expired = new FakePairingServer({ completeScript: ['gone'] });
    await expired.listen();
    try {
      const error: unknown = await runLogin({
        configDir,
        addressInput: expired.baseUrl,
        deviceName: 'Pippa',
        deps: deps(),
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PairingRefusedError);
      if (error instanceof PairingRefusedError) {
        expect(error.serverMessage).toBe(PAIRING_GONE_MESSAGE);
      }
      expect(() => readFileSync(path.join(configDir, 'instances.json'), 'utf8')).toThrow();
      expect(printed.join('\n')).not.toContain(FAKE_TERMINAL_KEY);
    } finally {
      await expired.close();
    }
  });

  it('shows the address refusal exactly as sent when the address is not listed', async () => {
    const refused = new FakePairingServer({ refuseStartAsUnlistedAddress: true });
    await refused.listen();
    try {
      const error: unknown = await runLogin({
        configDir,
        addressInput: refused.baseUrl,
        deviceName: 'Pippa',
        deps: deps(),
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PairingRefusedError);
      if (error instanceof PairingRefusedError) {
        expect(error.serverMessage).toBe(ADDRESS_NOT_LISTED_MESSAGE);
      }
    } finally {
      await refused.close();
    }
  });

  it('reports an expired code in plain words when the code runs out while waiting', async () => {
    const waiting = new FakePairingServer({ completeScript: ['waiting'] });
    await waiting.listen();
    try {
      const error: unknown = await runLogin({
        configDir,
        addressInput: waiting.baseUrl,
        deviceName: 'Pippa',
        deps: { ...deps(), now: () => Date.now() + 10 * 60_000 },
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PairingRefusedError);
      if (error instanceof PairingRefusedError) {
        expect(error.serverMessage).toBe('That pairing code has expired. Start pairing again with aman-tui login.');
      }
    } finally {
      await waiting.close();
    }
  });
});
