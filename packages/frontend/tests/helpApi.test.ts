import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHelpApi, parseHelpHealthCheck } from '../src/helpApi';

const VALID = {
  checked_at: '2026-10-21T09:00:00Z',
  model_ready: false,
  items: [
    {
      id: 'model',
      name: 'Your model',
      status: 'fail',
      message: 'No model is connected.',
      next_step: null,
    },
    { id: 'mail_calendar', name: 'Email and calendar', status: 'not_set_up', message: 'Not set up.', next_step: null },
  ],
  host_report: {
    state: 'missing',
    checked_at: null,
    message: null,
    next_step: null,
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('parseHelpHealthCheck', () => {
  it('reads a well-formed health check', () => {
    const check = parseHelpHealthCheck(VALID);

    assert.equal(check.model_ready, false);
    assert.equal(check.items[0]?.status, 'fail');
    assert.equal(check.host_report.state, 'missing');
  });

  it('refuses a response with an unknown status rather than showing it green', () => {
    const broken = { ...VALID, items: [{ ...VALID.items[0], status: 'maybe' }] };

    assert.throws(() => parseHelpHealthCheck(broken), /invalid/);
  });

  it('refuses a response without the model flag', () => {
    const { model_ready: _ignored, ...rest } = VALID;

    assert.throws(() => parseHelpHealthCheck(rest), /invalid/);
  });
});

describe('createHelpApi', () => {
  it('fetches the health check from the help route', async () => {
    const urls: string[] = [];
    const api = createHelpApi({
      fetcher: async input => {
        urls.push(String(input));
        return jsonResponse({ data: VALID });
      },
      listPersonas: async () => [],
    });

    const check = await api.getHealthCheck();

    assert.deepEqual(urls, ['/api/v1/help/health-check']);
    assert.equal(check.model_ready, false);
  });

  it('reports Iris as there only when the personas list holds her', async () => {
    const withIris = createHelpApi({
      fetcher: async () => jsonResponse({ data: VALID }),
      listPersonas: async () => [
        {
          id: 'iris-1',
          display_name: 'Iris',
          aliases: [],
          instructions: '',
          model_name: 'tokenfactory/model-a',
        },
      ],
    });
    const withoutIris = createHelpApi({
      fetcher: async () => jsonResponse({ data: VALID }),
      listPersonas: async () => [],
    });

    assert.equal(await withIris.ensureGuide(), true);
    assert.equal(await withoutIris.ensureGuide(), false);
  });

  it('throws the server message when the health check fails', async () => {
    const api = createHelpApi({
      fetcher: async () => jsonResponse({ error: { message: 'Sign in again.' } }, 401),
      listPersonas: async () => [],
    });

    await assert.rejects(api.getHealthCheck(), /Sign in again\./);
  });
});
