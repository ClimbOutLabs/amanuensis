import type { AuditRecordInput } from '@truefoundry/trueforge-core/core';
import { mkdtempSync } from 'node:fs';
import {
  createServer as createTcpServer,
  connect as netConnect,
  type Socket,
  type Server as TcpServer,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createLogger, format, transports } from 'winston';
import { SkillNetworkGateway } from '../../../../src/sandbox/skillnet/skillNetworkGateway';
import { SkillNetworkTokenRegistry } from '../../../../src/sandbox/skillnet/skillNetworkTokens';

/** The worked example from the design: the ten-x skill's two GitHub hosts. */
const HOSTS = ['github.com', 'api.github.com'];
const GRANT_INPUT = { tenant_id: 't', created_by: 'o', session_id: 's' };

interface Harness {
  socketPath: string;
  registry: SkillNetworkTokenRegistry;
  dials: { host: string; port: number }[];
  auditRecords: AuditRecordInput[];
  logLines: () => string;
  close: () => Promise<void>;
}

async function setup(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'tfy-skillnet-'));
  const socketPath = join(dir, 'skillnet.sock');
  const registry = new SkillNetworkTokenRegistry();
  const dials: { host: string; port: number }[] = [];
  // The stand-in upstream: an echo server. Whatever the gateway tunnels comes straight back.
  const echo: TcpServer = createTcpServer(socket => {
    socket.pipe(socket);
  });
  await new Promise<void>(resolve => {
    echo.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const echoAddress = echo.address();
  if (echoAddress === null || typeof echoAddress === 'string') {
    throw new Error('echo server has no port');
  }
  const logChunks: string[] = [];
  const logStream = new PassThrough();
  logStream.on('data', (chunk: Buffer) => {
    logChunks.push(chunk.toString('utf8'));
  });
  const logger = createLogger({
    format: format.json(),
    transports: [new transports.Stream({ stream: logStream })],
  });
  const auditRecords: AuditRecordInput[] = [];
  const gateway = new SkillNetworkGateway({
    registry,
    logger,
    audit: {
      record: input => {
        auditRecords.push(input);
        return Promise.resolve();
      },
    },
    connectUpstream: ({ host, port }) => {
      dials.push({ host, port });
      return new Promise((resolve, reject) => {
        const socket = netConnect(echoAddress.port, '127.0.0.1');
        socket.once('connect', () => {
          resolve(socket);
        });
        socket.once('error', reject);
      });
    },
  });
  await gateway.listenOnSockets([socketPath]);
  return {
    socketPath,
    registry,
    dials,
    auditRecords,
    logLines: () => logChunks.join(''),
    close: async () => {
      await gateway.close();
      await new Promise<void>(resolve => {
        echo.close(() => {
          resolve();
        });
      });
    },
  };
}

interface ConnectReply {
  status: number;
  body: string;
  socket: Socket | undefined;
}

/** One raw CONNECT call to the gateway socket, the way the slot agent's forwarder makes it. */
function connectVia(
  socketPath: string,
  input: { authority: string; token?: string | undefined },
): Promise<ConnectReply> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    socket.once('error', reject);
    socket.once('connect', () => {
      const tokenLine = input.token === undefined ? '' : `X-Aman-Skill-Network-Token: ${input.token}\r\n`;
      socket.write(`CONNECT ${input.authority} HTTP/1.1\r\nHost: ${input.authority}\r\n${tokenLine}\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const head = buffer.subarray(0, headerEnd).toString('utf8');
      const status = Number(head.split(' ')[1] ?? '0');
      if (status === 200) {
        settled = true;
        resolve({ status, body: '', socket });
        return;
      }
      // A refusal carries its plain-words body and then the gateway closes.
      const rest = buffer.subarray(headerEnd + 4).toString('utf8');
      socket.once('end', () => {
        if (!settled) {
          settled = true;
          resolve({ status, body: rest, socket: undefined });
        }
      });
      socket.once('close', () => {
        if (!settled) {
          settled = true;
          resolve({ status, body: rest, socket: undefined });
        }
      });
    });
  });
}

describe('SkillNetworkGateway', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setup();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('tunnels a connection to a site in the grant', async () => {
    const token = harness.registry.issue({ ...GRANT_INPUT, hosts: HOSTS });
    const reply = await connectVia(harness.socketPath, { authority: 'github.com:443', token });
    expect(reply.status).toBe(200);
    const socket = reply.socket;
    if (socket === undefined) throw new Error('expected a tunnel socket');
    const echoed = new Promise<string>(resolve => {
      socket.once('data', (chunk: Buffer) => {
        resolve(chunk.toString('utf8'));
      });
    });
    socket.write('through the tunnel');
    await expect(echoed).resolves.toBe('through the tunnel');
    socket.destroy();
    expect(harness.dials).toEqual([{ host: 'github.com', port: 443 }]);
  });

  it('refuses any other site, names it, and never dials it', async () => {
    const token = harness.registry.issue({ ...GRANT_INPUT, hosts: HOSTS });
    const reply = await connectVia(harness.socketPath, { authority: 'evil.example.com:443', token });
    expect(reply.status).toBe(403);
    expect(reply.body).toContain('evil.example.com is not one of the sites approved for the skills in this chat');
    expect(reply.body).toContain('Settings, then Skills');
    expect(harness.dials).toEqual([]);
    // The refusal lands in the audit log with the site that was asked for.
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(harness.logLines()).toContain('evil.example.com');
    expect(harness.logLines()).toContain('Skill network connection refused');
  });

  it('refuses a call with no token and one with an unknown token', async () => {
    harness.registry.issue({ ...GRANT_INPUT, hosts: HOSTS });
    const noToken = await connectVia(harness.socketPath, { authority: 'github.com:443' });
    expect(noToken.status).toBe(403);
    const unknown = await connectVia(harness.socketPath, {
      authority: 'github.com:443',
      token: 'f'.repeat(32),
    });
    expect(unknown.status).toBe(403);
    expect(harness.dials).toEqual([]);
  });

  it('carries secure connections only: a granted site on another port is refused', async () => {
    const token = harness.registry.issue({ ...GRANT_INPUT, hosts: HOSTS });
    const reply = await connectVia(harness.socketPath, { authority: 'github.com:8443', token });
    expect(reply.status).toBe(403);
    expect(reply.body).toContain('Only secure (HTTPS) connections are carried');
    expect(harness.dials).toEqual([]);
  });

  it('ends reachability when the grant is replaced or revoked, as a Settings change does', async () => {
    const token = harness.registry.issue({ ...GRANT_INPUT, hosts: HOSTS });
    const before = await connectVia(harness.socketPath, { authority: 'github.com:443', token });
    expect(before.status).toBe(200);
    before.socket?.destroy();

    // The approval is taken back: the resolver revokes the session, and the same token is dead.
    harness.registry.revokeSession('s');
    const after = await connectVia(harness.socketPath, { authority: 'github.com:443', token });
    expect(after.status).toBe(403);
    expect(harness.dials).toEqual([{ host: 'github.com', port: 443 }]);
  });

  it('writes a refused site to the activity log under its chat, exactly once', async () => {
    const token = harness.registry.issue({ ...GRANT_INPUT, hosts: HOSTS });
    const reply = await connectVia(harness.socketPath, { authority: 'evil.example.com:443', token });
    expect(reply.status).toBe(403);

    await new Promise(resolve => setTimeout(resolve, 25));
    expect(harness.auditRecords).toEqual([
      expect.objectContaining({
        tenant_id: 't',
        created_by: 'o',
        conversation_id: 's',
        tier: 3,
        tool_name: 'skill_network',
        outcome: 'auto_denied',
        auto_deny_reason: null,
      }),
    ]);
    expect(harness.auditRecords[0]?.description).toContain('evil.example.com');
    expect(harness.auditRecords[0]?.description).toContain('not one of its approved sites');
  });

  it('writes a granted site reached on another port to the activity log', async () => {
    const token = harness.registry.issue({ ...GRANT_INPUT, hosts: HOSTS });
    const reply = await connectVia(harness.socketPath, { authority: 'github.com:8443', token });
    expect(reply.status).toBe(403);

    await new Promise(resolve => setTimeout(resolve, 25));
    expect(harness.auditRecords).toHaveLength(1);
    expect(harness.auditRecords[0]?.description).toContain('github.com');
    expect(harness.auditRecords[0]?.description).toContain('without a secure connection');
  });

  it('writes nothing to the activity log for a connection that opens', async () => {
    const token = harness.registry.issue({ ...GRANT_INPUT, hosts: HOSTS });
    const reply = await connectVia(harness.socketPath, { authority: 'github.com:443', token });
    expect(reply.status).toBe(200);
    reply.socket?.destroy();

    await new Promise(resolve => setTimeout(resolve, 25));
    expect(harness.auditRecords).toEqual([]);
  });

  it('writes nothing to the activity log for a call with no token, since it names no chat', async () => {
    harness.registry.issue({ ...GRANT_INPUT, hosts: HOSTS });
    const reply = await connectVia(harness.socketPath, { authority: 'github.com:443' });
    expect(reply.status).toBe(403);

    await new Promise(resolve => setTimeout(resolve, 25));
    expect(harness.auditRecords).toEqual([]);
  });

  it('answers a plain request with 405: this address carries connections, not pages', async () => {
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const socket = netConnect(harness.socketPath);
      let text = '';
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write('GET http://github.com/ HTTP/1.1\r\nHost: github.com\r\n\r\n');
      });
      socket.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
      });
      socket.once('end', () => {
        resolve({ status: Number(text.split(' ')[1] ?? '0'), body: text });
      });
    });
    expect(reply.status).toBe(405);
  });
});
