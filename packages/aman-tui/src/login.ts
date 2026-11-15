import { hostname } from 'node:os';

import {
  loadInstanceStore,
  normalizeInstanceAddress,
  saveInstanceStore,
  upsertInstance,
  type SavedInstance,
} from './instances.js';
import { chooseKeyStore, type KeyStore } from './keyStore.js';
import { createPairingClient, PairingRefusedError, type PairingClient } from './pairing.js';

/** What a login needs from the world, injectable so the whole flow can be tested against a fake server. */
export interface LoginDeps {
  print: (line: string) => void;
  createPairingClient?: (baseUrl: string) => PairingClient;
  chooseKeyStore?: (configDir: string) => Promise<KeyStore>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;

/** The name a terminal pairs under when the person does not give one: this computer's name. */
export function defaultDeviceName(): string {
  const name = hostname().split('.')[0]?.trim() ?? '';
  return (name === '' ? 'Terminal' : name).slice(0, 80);
}

/**
 * Pairs this terminal with one instance: starts a pairing, shows the code and
 * the confirm link in large clear text, waits while the person confirms in the
 * web app, then saves the key it is handed, once, into the store the platform
 * offers. The key is never printed. A refusal shows the server's own line.
 */
export async function runLogin(options: {
  configDir: string;
  addressInput: string;
  deviceName?: string;
  deps: LoginDeps;
}): Promise<SavedInstance> {
  const { print } = options.deps;
  const address = normalizeInstanceAddress(options.addressInput);
  if (address === undefined) {
    throw new Error(
      `"${options.addressInput}" does not read as an address. Give the address Aman is opened at, for example aman-tui login https://my-computer.example:8443`,
    );
  }
  const deviceName = (options.deviceName ?? defaultDeviceName()).slice(0, 80);
  const pairing = (options.deps.createPairingClient ?? ((baseUrl: string) => createPairingClient({ baseUrl })))(
    address,
  );
  const sleep = options.deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.deps.now ?? Date.now;
  const pollIntervalMs = options.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const started = await pairing.start(deviceName);
  print('');
  print('  Pair this terminal');
  print('');
  print(`      ${started.code.split('').join(' ')}`);
  print('');
  print(`  Open this link in the web app and confirm the code: ${started.confirmUrl}`);
  print('  The code works once and lasts five minutes.');
  print('  Waiting for you to confirm...');

  const expiresAtMs = Date.parse(started.expiresAt);
  const finishPairing = async (paired: { terminalKey: string; deviceName: string }): Promise<SavedInstance> => {
    const keyStore = await (options.deps.chooseKeyStore ?? ((configDir: string) => chooseKeyStore({ configDir })))(
      options.configDir,
    );
    await keyStore.set({ address, key: paired.terminalKey });
    const instance: SavedInstance = { address, deviceName: paired.deviceName, keyStore: keyStore.kind };
    saveInstanceStore(options.configDir, upsertInstance(loadInstanceStore(options.configDir), instance));
    print(`  Paired. This terminal is "${paired.deviceName}" at ${address}.`);
    print('  Run aman-tui to start chatting.');
    return instance;
  };
  for (;;) {
    const completion = await pairing.complete({ pairingId: started.pairingId, code: started.code });
    if (completion.status === 'paired') {
      return finishPairing(completion);
    }
    if (Number.isFinite(expiresAtMs) && now() > expiresAtMs) {
      // One last poll: the server drops an expired pairing, and its refusal is
      // the line to show. A pairing confirmed at the last moment still counts.
      const final = await pairing.complete({ pairingId: started.pairingId, code: started.code });
      if (final.status === 'paired') {
        return finishPairing(final);
      }
      throw new PairingRefusedError('That pairing code has expired. Start pairing again with aman-tui login.', 404);
    }
    await sleep(pollIntervalMs);
  }
}
