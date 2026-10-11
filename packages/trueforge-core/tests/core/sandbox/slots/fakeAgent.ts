import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  SLOT_AGENT_VERSION,
  SLOT_PLATFORM,
  SLOT_REQUIRED_CHECKS,
  SLOT_RUNSC_VERSION,
  type SlotAttestation,
} from '../../../../src/core/sandbox/slots/slotContract';

export interface FakeReply {
  status: number;
  body: unknown;
  /** Delay before replying, ms. */
  delayMs?: number;
}

export type FakeHandler = (request: { method: string; path: string; body: unknown }) => FakeReply;

/** Parses a recorded request body with the schema the test expects, instead of asserting its type. */
export function bodyOf<T>(request: { body: unknown } | undefined, schema: z.ZodType<T>): T {
  return schema.parse(request?.body);
}

export function attestation(
  overrides: { failing?: string[]; omitted?: string[]; checkedAt?: Date; duplicated?: string } = {},
): SlotAttestation {
  const failing = new Set(overrides.failing ?? []);
  const omitted = new Set(overrides.omitted ?? []);
  const checks = SLOT_REQUIRED_CHECKS.filter(name => !omitted.has(name)).map(name => ({
    name,
    ok: !failing.has(name),
    detail: failing.has(name) ? `${name} is wrong` : 'fine',
  }));
  const duplicated = checks.find(check => check.name === overrides.duplicated);
  return {
    schema: 1,
    agent_version: SLOT_AGENT_VERSION,
    ok: failing.size === 0 && omitted.size === 0,
    checked_at: (overrides.checkedAt ?? new Date()).toISOString(),
    checks: duplicated === undefined ? checks : [...checks, duplicated],
    facts: {
      kernel: 'k',
      arch: 'amd64',
      page_size: 4096,
      cgroup: 'v2',
      apparmor: 'none',
      runsc_version: SLOT_RUNSC_VERSION,
      platform: SLOT_PLATFORM,
    },
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed: unknown = text === '' ? undefined : JSON.parse(text);
  return parsed;
}

/** A slot agent stand-in listening on a Unix socket in a private temp directory. */
export class FakeAgent {
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  private server: Server | undefined;
  private dir: string | undefined;

  constructor(private readonly handler: FakeHandler) {}

  async start(): Promise<string> {
    this.dir = await mkdtemp(join(tmpdir(), 'fake-slot-'));
    const socketPath = join(this.dir, 'agent.sock');
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const body = await readBody(req);
        const request = { method: req.method ?? '', path: req.url ?? '', body };
        this.requests.push(request);
        const reply = this.handler(request);
        if (reply.delayMs !== undefined) {
          await new Promise(resolve => setTimeout(resolve, reply.delayMs).unref());
        }
        if (reply.status === 204) {
          res.writeHead(204).end();
          return;
        }
        res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
      })();
    });
    const server = this.server;
    await new Promise<void>(resolve => {
      server.listen(socketPath, resolve);
    });
    return socketPath;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    const server = this.server;
    await new Promise<void>(resolve => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => {
        resolve();
      });
    });
    if (this.dir !== undefined) {
      await rm(this.dir, { recursive: true, force: true });
    }
  }
}

export function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}
