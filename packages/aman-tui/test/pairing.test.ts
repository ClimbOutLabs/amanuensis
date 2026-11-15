import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPairingClient, PairingRefusedError } from '../src/pairing.js';
import {
  ADDRESS_NOT_LISTED_MESSAGE,
  FAKE_TERMINAL_KEY,
  FakePairingServer,
  PAIRING_GONE_MESSAGE,
} from './fakePairingServer.js';

describe('pairing client against a fake Step 1 server', () => {
  let server: FakePairingServer;

  beforeEach(async () => {
    server = new FakePairingServer();
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
  });

  it('starts a pairing with the device name and an Origin naming the instance', async () => {
    const client = createPairingClient({ baseUrl: server.baseUrl });
    const started = await client.start('Pippa');
    expect(started.code).toBe('WXYZ-2345');
    expect(started.pairingId).toBe('pairing-nora-1');
    expect(started.confirmUrl).toBe(`${server.baseUrl}/pair-terminal?code=WXYZ-2345`);
    const request = server.requests[0];
    expect(request?.path).toBe('/api/v1/terminal-pairings');
    expect(request?.origin).toBe(server.baseUrl);
    expect(request?.body).toEqual({ device_name: 'Pippa' });
  });

  it('polls waiting, then receives the key exactly once', async () => {
    const client = createPairingClient({ baseUrl: server.baseUrl });
    await client.start('Pippa');
    await expect(client.complete({ pairingId: 'pairing-nora-1', code: 'WXYZ-2345' })).resolves.toEqual({
      status: 'waiting',
    });
    await expect(client.complete({ pairingId: 'pairing-nora-1', code: 'WXYZ-2345' })).resolves.toEqual({
      status: 'paired',
      terminalKey: FAKE_TERMINAL_KEY,
      deviceName: 'Pippa',
    });
    // The key was handed over once: the next poll reads as the server's refusal line.
    await expect(client.complete({ pairingId: 'pairing-nora-1', code: 'WXYZ-2345' })).rejects.toMatchObject({
      serverMessage: PAIRING_GONE_MESSAGE,
    });
    const completeRequests = server.requests.filter(request => request.path === '/api/v1/terminal-pairings/complete');
    expect(completeRequests.every(request => request.origin === server.baseUrl)).toBe(true);
  });

  it('shows the refusal line verbatim for an expired code', async () => {
    const expired = new FakePairingServer({ completeScript: ['gone'] });
    await expired.listen();
    try {
      const client = createPairingClient({ baseUrl: expired.baseUrl });
      await client.start('Pippa');
      const error: unknown = await client
        .complete({ pairingId: 'pairing-nora-1', code: 'WXYZ-2345' })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PairingRefusedError);
      if (error instanceof PairingRefusedError) {
        expect(error.serverMessage).toBe(PAIRING_GONE_MESSAGE);
        expect(error.status).toBe(404);
      }
    } finally {
      await expired.close();
    }
  });

  it('shows the address refusal exactly as the server sent it', async () => {
    const refused = new FakePairingServer({ refuseStartAsUnlistedAddress: true });
    await refused.listen();
    try {
      const client = createPairingClient({ baseUrl: refused.baseUrl });
      const error: unknown = await client.start('Pippa').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PairingRefusedError);
      if (error instanceof PairingRefusedError) {
        expect(error.serverMessage).toBe(ADDRESS_NOT_LISTED_MESSAGE);
        expect(error.status).toBe(421);
      }
    } finally {
      await refused.close();
    }
  });

  it('revokes the current key with the key as its Bearer token', async () => {
    const client = createPairingClient({ baseUrl: server.baseUrl });
    await expect(client.revokeCurrent(FAKE_TERMINAL_KEY)).resolves.toBeUndefined();
    const request = server.requests.find(candidate => candidate.path === '/api/v1/terminal-pairings/revoke-current');
    expect(request?.authorization).toBe(`Bearer ${FAKE_TERMINAL_KEY}`);
    await expect(client.revokeCurrent('aman_tk_wrong')).rejects.toMatchObject({ status: 401 });
  });
});
