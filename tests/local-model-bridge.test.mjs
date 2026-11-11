// The local model bridge: a request made to the link side reaches a model listening only on this computer's loopback
// address, through the socket file the two sides share, and nothing else is accepted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parsePorts, startBridge } from '../ops/compose/local-model/bridge.mjs';

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

async function freePort() {
  const probe = http.createServer();
  await listenOn(probe, 0, '127.0.0.1');
  const address = probe.address();
  await new Promise(resolve => probe.close(resolve));
  if (address === null || typeof address === 'string') {
    throw new Error('no port');
  }
  return address.port;
}

function get({ host, port }) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host, port, path: '/v1/models' }, response => {
      let body = '';
      response.on('data', chunk => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
  });
}

async function withBridge(port, run) {
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aman-local-model-'));
  const servers = [
    ...(await startBridge({ side: 'host', ports: [port], socketDir, target: '127.0.0.1', listenHost: undefined })),
    // The link side stands in for the container: another loopback address, the same port number.
    ...(await startBridge({ side: 'link', ports: [port], socketDir, target: undefined, listenHost: '127.0.0.2' })),
  ];
  try {
    await run();
  } finally {
    for (const server of servers) {
      server.close();
    }
    fs.rmSync(socketDir, { recursive: true, force: true });
  }
}

test('a model that listens only on loopback answers through the bridge', async () => {
  const port = await freePort();
  const model = http.createServer((_request, response) => response.end('{"data":[{"id":"local"}]}'));
  await listenOn(model, port, '127.0.0.1');
  try {
    await withBridge(port, async () => {
      const answer = await get({ host: '127.0.0.2', port });
      assert.equal(answer.status, 200);
      assert.equal(answer.body, '{"data":[{"id":"local"}]}');
    });
  } finally {
    model.close();
  }
});

test('a model that is not running ends the connection without an answer', async () => {
  const port = await freePort();
  await withBridge(port, async () => {
    await assert.rejects(get({ host: '127.0.0.2', port }), error => error instanceof Error);
  });
});

test('the host side listens on its socket file only, never on a network port', async () => {
  const port = await freePort();
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aman-local-model-'));
  const [server] = await startBridge({
    side: 'host',
    ports: [port],
    socketDir,
    target: '127.0.0.1',
    listenHost: undefined,
  });
  try {
    assert.equal(server.address(), path.join(socketDir, `${port}.sock`));
  } finally {
    server.close();
    fs.rmSync(socketDir, { recursive: true, force: true });
  }
});

test('only ports from 1024 to 65535 are accepted', () => {
  assert.deepEqual(parsePorts('30031,11434'), [30031, 11434]);
  for (const bad of ['', '80', '65536', '0123', 'abc', '30031,x']) {
    assert.throws(() => parsePorts(bad), /LOCAL_MODEL_PORTS/);
  }
});
