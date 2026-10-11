import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRunCodeStatusApi } from '../src/runCodeStatusApi';

test('run_code status API reads the live status from the settings route', async () => {
  const requests: Request[] = [];
  const api = createRunCodeStatusApi(async input => {
    requests.push(new Request(new URL(String(input), 'http://localhost')));
    return Response.json({ data: { state: 'signature_unverified', detail: 'cosign failed' } });
  });

  assert.deepEqual(await api.getRunCodeStatus(), { state: 'signature_unverified', detail: 'cosign failed' });
  assert.equal(new URL(requests[0]?.url ?? '').pathname, '/api/v1/settings/run-code/status');
});

test('run_code status API surfaces the server error message', async () => {
  const api = createRunCodeStatusApi(async () =>
    Response.json({ error: { message: 'Docker probe crashed' } }, { status: 500 }),
  );
  await assert.rejects(api.getRunCodeStatus(), { message: 'Docker probe crashed' });
});

test('run_code status API falls back to the HTTP status when the body is not an error envelope', async () => {
  const api = createRunCodeStatusApi(async () => new Response('Bad Gateway', { status: 502 }));
  await assert.rejects(api.getRunCodeStatus(), { message: 'Request failed (502).' });
});

test('run_code status API rejects a state it does not know', async () => {
  const api = createRunCodeStatusApi(async () => Response.json({ data: { state: 'on_fire' } }));
  await assert.rejects(api.getRunCodeStatus(), { message: 'The sandbox status response was invalid.' });
});
