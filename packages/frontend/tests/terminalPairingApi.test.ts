import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTerminalPairingApi } from '../src/terminalPairingApi';

const REFUSAL_LINE =
  'That pairing code is not right, or it has expired. On the terminal, start pairing again and use the new code.';

const PIPPA_ROW = {
  id: 'key-pippa',
  device_name: 'Pippa',
  paired_at: '2026-11-14T09:15:00.000Z',
  last_used_at: '2026-11-15T08:02:00.000Z',
  revoked_at: null,
};

const OLD_ROW = {
  id: 'key-old',
  device_name: "Nora's old laptop",
  paired_at: '2026-10-02T12:00:00.000Z',
  last_used_at: '2026-10-20T12:00:00.000Z',
  revoked_at: '2026-11-01T12:00:00.000Z',
};

type CapturedCall = { url: string; method: string | undefined; body: string | undefined };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetcherReturning(response: Response, capture: CapturedCall): typeof fetch {
  return async (url, init) => {
    capture.url = typeof url === 'string' ? url : '';
    capture.method = init?.method;
    capture.body = typeof init?.body === 'string' ? init.body : undefined;
    return response;
  };
}

const emptyCapture = (): CapturedCall => ({ url: '', method: undefined, body: undefined });

describe('createTerminalPairingApi', () => {
  it('confirms a code and returns the terminal that was paired', async () => {
    const capture = emptyCapture();
    const api = createTerminalPairingApi(
      fetcherReturning(
        jsonResponse({ data: { device_name: 'Pippa', paired_at: '2026-11-15T10:30:00.000Z' } }),
        capture,
      ),
    );

    const confirmation = await api.confirmPairing({ code: 'K7QX-42PD' });

    assert.deepEqual(confirmation, { device_name: 'Pippa', paired_at: '2026-11-15T10:30:00.000Z' });
    assert.equal(capture.method, 'POST');
    assert.ok(capture.url.endsWith('/api/v1/terminal-pairings/confirm'), capture.url);
    assert.deepEqual(JSON.parse(capture.body ?? '{}'), { code: 'K7QX-42PD' });
  });

  it('surfaces the server one refusal line when a code is refused', async () => {
    const api = createTerminalPairingApi(
      fetcherReturning(jsonResponse({ error: { message: REFUSAL_LINE } }, 404), emptyCapture()),
    );

    await assert.rejects(api.confirmPairing({ code: 'K7QX-42PD' }), new Error(REFUSAL_LINE));
  });

  it('lists the paired terminals, revoked ones included', async () => {
    const capture = emptyCapture();
    const api = createTerminalPairingApi(fetcherReturning(jsonResponse({ data: [PIPPA_ROW, OLD_ROW] }), capture));

    const terminals = await api.listPairedTerminals();

    assert.deepEqual(terminals, [PIPPA_ROW, OLD_ROW]);
    assert.equal(capture.method, 'GET');
    assert.ok(capture.url.endsWith('/api/v1/settings/terminal-keys'), capture.url);
  });

  it('refuses a list answer whose rows do not match the wire shape', async () => {
    const api = createTerminalPairingApi(
      fetcherReturning(jsonResponse({ data: [{ id: 'key-pippa' }] }), emptyCapture()),
    );

    await assert.rejects(
      api.listPairedTerminals(),
      new Error('The paired terminals could not be loaded. Try again in a moment.'),
    );
  });

  it('revokes a terminal by id', async () => {
    const capture = emptyCapture();
    const api = createTerminalPairingApi(fetcherReturning(jsonResponse({}), capture));

    await api.revokePairedTerminal({ terminal_key_id: 'key-pippa' });

    assert.equal(capture.method, 'DELETE');
    assert.ok(capture.url.endsWith('/api/v1/settings/terminal-keys/key-pippa'), capture.url);
  });

  it('surfaces the server line when a revoke is refused', async () => {
    const api = createTerminalPairingApi(
      fetcherReturning(jsonResponse({ error: { message: 'That terminal key is not there.' } }, 404), emptyCapture()),
    );

    await assert.rejects(
      api.revokePairedTerminal({ terminal_key_id: 'key-gone' }),
      new Error('That terminal key is not there.'),
    );
  });

  it('says the server could not be reached when the fetch itself fails', async () => {
    const fetcher: typeof fetch = async () => {
      throw new Error('network down');
    };
    const api = createTerminalPairingApi(fetcher);

    await assert.rejects(
      api.listPairedTerminals(),
      new Error("Couldn't reach the server. Check your connection and try again."),
    );
  });
});
