import type { Server } from 'node:http';

import { createMasterKey } from '../../../src/secrets/keyCheck';
import type { KeyLoadResult, KeyProvider } from '../../../src/secrets/keyProvider';
import { waitForMachineKey, type KeyCheckResult, type StartupLock } from '../../../src/secrets/startupGate';

class SlotProvider implements KeyProvider {
  key: Buffer | undefined;

  load(): Promise<KeyLoadResult> {
    return Promise.resolve(
      this.key === undefined ? { status: 'unavailable', reason: 'not delivered' } : { status: 'loaded', key: this.key },
    );
  }
}

function listenOnFreePort(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('not listening');
  }
  return address.port;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (!check()) {
    throw new Error('Timed out waiting');
  }
}

describe('waitForMachineKey', () => {
  it('opens at once, without a locked server, when the right key is already there', async () => {
    const provider = new SlotProvider();
    provider.key = createMasterKey();
    const listen = jest.fn(listenOnFreePort);
    const locks: StartupLock[] = [];
    const key = await waitForMachineKey({
      provider,
      checkKey: () => Promise.resolve('match'),
      listen,
      onLockChange: lock => locks.push(lock),
    });
    expect(key.equals(provider.key)).toBe(true);
    expect(listen).not.toHaveBeenCalled();
    expect(locks).toEqual([]);
  });

  it('serves only the locked page while waiting, then opens by itself when the key arrives', async () => {
    const provider = new SlotProvider();
    let server: Server | undefined;
    const locks: StartupLock[] = [];
    const waiting = waitForMachineKey({
      provider,
      checkKey: () => Promise.resolve('match'),
      listen: async created => {
        server = created;
        await listenOnFreePort(created);
      },
      onLockChange: lock => locks.push(lock),
      fastMs: 10,
    });
    await until(() => server?.listening === true);
    if (server === undefined) {
      throw new Error('no server');
    }
    const base = `http://127.0.0.1:${String(portOf(server))}`;

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ status: 'locked', reason: 'no_key' });

    const api = await fetch(`${base}/api/v1/sessions`, { method: 'POST', body: '{}' });
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ error: { code: 'locked', reason: 'no_key' } });

    const page = await fetch(`${base}/anything`);
    expect(page.status).toBe(503);
    const html = await page.text();
    expect(html).toContain("waiting for this computer's key");
    expect(html).toContain('aman doctor');

    provider.key = createMasterKey();
    const key = await waiting;
    expect(key.equals(provider.key)).toBe(true);
    expect(server.listening).toBe(false);
    expect(locks.map(lock => lock.reason)).toEqual(['no_key']);
  });

  it('stays locked for a key that is wrong or an instance that is not set up, and says which', async () => {
    const provider = new SlotProvider();
    provider.key = createMasterKey();
    let answer: KeyCheckResult = 'wrong_key';
    let server: Server | undefined;
    const locks: StartupLock[] = [];
    const waiting = waitForMachineKey({
      provider,
      checkKey: () => Promise.resolve(answer),
      listen: async created => {
        server = created;
        await listenOnFreePort(created);
      },
      onLockChange: lock => locks.push(lock),
      fastMs: 10,
    });
    await until(() => server?.listening === true);
    if (server === undefined) {
      throw new Error('no server');
    }
    const base = `http://127.0.0.1:${String(portOf(server))}`;
    expect(await (await fetch(`${base}/`)).text()).toContain('aman unlock');

    answer = 'not_set_up';
    await until(() => locks.length === 2);
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: 'locked', reason: 'not_set_up' });

    answer = 'match';
    await waiting;
    expect(locks.map(lock => lock.reason)).toEqual(['wrong_key', 'not_set_up']);
  });
});
