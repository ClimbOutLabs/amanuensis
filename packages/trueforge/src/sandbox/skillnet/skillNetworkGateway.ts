import type { AuditLogWriter } from '@truefoundry/trueforge-core/core';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import type { Logger } from 'winston';
import { guardedLookup } from '../mirrors/packageMirrorGateway';
import type { SkillNetworkGrant, SkillNetworkTokenRegistry } from './skillNetworkTokens';

/** Header the slot agent's forwarder sets on every CONNECT it passes on, carrying the call's token. */
export const SKILL_NETWORK_TOKEN_HEADER = 'x-aman-skill-network-token';

const CONNECT_TIMEOUT_MS = 30_000;

export interface SkillNetworkGatewayOptions {
  registry: SkillNetworkTokenRegistry;
  logger: Logger;
  /**
   * The activity log a refused connection is also written to, so a stopped attempt shows beside
   * the actions that ran. Absent or null, refusals are only written to the server log, as before.
   */
  audit?: AuditLogWriter | null | undefined;
  /**
   * Test seam only: replaces the real dial (guarded DNS, public addresses only) with a local
   * stand-in, for any host name. The server never sets this; its gateway always resolves names
   * itself and refuses answers that are not public addresses.
   */
  connectUpstream?: ((input: { host: string; port: number }) => Promise<Socket>) | undefined;
}

/**
 * The host-side skill network gateway: the one way a sandbox with a skill network grant reaches
 * the sites the person approved. It listens only on Unix sockets inside the slots' control
 * directories, takes CONNECT requests from the slot agent's forwarder, and tunnels only to a
 * site named in the call's grant. It never looks inside the encrypted connection: the site name
 * is the whole decision, and every refusal is written to the log with the site that was asked
 * for, the chat, and the grant it was checked against.
 */
export class SkillNetworkGateway {
  readonly #registry: SkillNetworkTokenRegistry;
  readonly #logger: Logger;
  readonly #audit: AuditLogWriter | null;
  readonly #connectUpstream: SkillNetworkGatewayOptions['connectUpstream'];
  readonly #servers: Server[] = [];

  constructor(options: SkillNetworkGatewayOptions) {
    this.#registry = options.registry;
    this.#logger = options.logger.child({ module: 'SkillNetworkGateway' });
    this.#audit = options.audit ?? null;
    this.#connectUpstream = options.connectUpstream;
  }

  async listenOnSockets(socketPaths: readonly string[]): Promise<void> {
    for (const socketPath of socketPaths) {
      await mkdir(path.dirname(socketPath), { recursive: true });
      await unlink(socketPath).catch(() => undefined);
      const server = createServer((_request, response) => {
        response.writeHead(405, { 'content-type': 'text/plain' });
        response.end('This address only carries secure connections for approved skills.\n');
      });
      server.on('connect', (request, socket, head) => {
        void this.#handleConnect({ authority: request.url, headers: request.headers, socket, head });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      // Same reason as the mirror gateway's socket: the slot agent runs as another user, and the
      // folder around the socket is what limits who can reach it.
      try {
        await chmod(socketPath, 0o666);
      } catch (error: unknown) {
        server.close();
        throw error;
      }
      this.#servers.push(server);
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      this.#servers.map(
        server =>
          new Promise<void>(resolve => {
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
    this.#servers.length = 0;
  }

  async #handleConnect(input: {
    authority: string | undefined;
    headers: Record<string, string | string[] | undefined>;
    socket: Duplex;
    head: Buffer;
  }): Promise<void> {
    const { socket } = input;
    const target = parseConnectTarget(input.authority);
    if (target === undefined) {
      this.#refuse({
        socket,
        status: 400,
        message: 'The connection request did not name a site.',
        host: undefined,
        grant: undefined,
        auditDescription: undefined,
      });
      return;
    }
    // The grant is read before the port check so a refused connection can still be written to the
    // activity log under its chat; the checks, their order, and their messages are unchanged.
    const tokenHeader = input.headers[SKILL_NETWORK_TOKEN_HEADER];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const grant = token === undefined ? undefined : this.#registry.resolve(token);
    if (target.port !== 443) {
      this.#refuse({
        socket,
        status: 403,
        message: 'Only secure (HTTPS) connections are carried. Connect to port 443.',
        host: target.host,
        grant,
        auditDescription: `A skill tried to reach ${target.host} without a secure connection, and it was refused.`,
      });
      return;
    }
    if (grant === undefined) {
      this.#refuse({
        socket,
        status: 403,
        message:
          'This chat has no network approval. Approve the skill’s sites in Settings, then Skills, and try again.',
        host: target.host,
        grant: undefined,
        auditDescription: undefined,
      });
      return;
    }
    if (!grant.hosts.includes(target.host)) {
      this.#refuse({
        socket,
        status: 403,
        message: `${target.host} is not one of the sites approved for the skills in this chat. To allow it, the skill must name it and the new list must be approved in Settings, then Skills.`,
        host: target.host,
        grant,
        auditDescription: `A skill tried to reach ${target.host}, which is not one of its approved sites, and the connection was refused.`,
      });
      return;
    }
    let upstream: Socket;
    try {
      upstream =
        this.#connectUpstream !== undefined
          ? await this.#connectUpstream({ host: target.host, port: target.port })
          : await dialPublicHost({ host: target.host, port: target.port });
    } catch (error) {
      this.#logger.warn('Skill network connection could not be opened', {
        host: target.host,
        session_id: grant.session_id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.#refuse({
        socket,
        status: 502,
        message: `Could not connect to ${target.host}. Check the site name and try again.`,
        host: target.host,
        grant,
        log: false,
        auditDescription: `A skill's connection to ${target.host} could not be opened.`,
      });
      return;
    }
    this.#logger.info('Skill network connection opened', {
      host: target.host,
      session_id: grant.session_id,
      tenant_id: grant.tenant_id,
      hosts: grant.hosts,
    });
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (input.head.length > 0) {
      upstream.write(input.head);
    }
    upstream.pipe(socket);
    socket.pipe(upstream);
    upstream.on('error', () => {
      socket.destroy();
    });
    socket.on('error', () => {
      upstream.destroy();
    });
  }

  #refuse(input: {
    socket: Duplex;
    status: number;
    message: string;
    host: string | undefined;
    grant: SkillNetworkGrant | undefined;
    log?: boolean;
    /** The activity log line for this refusal; left out when the call names no chat to file it under. */
    auditDescription: string | undefined;
  }): void {
    if (input.log !== false) {
      this.#logger.warn('Skill network connection refused', {
        host: input.host,
        session_id: input.grant?.session_id,
        tenant_id: input.grant?.tenant_id,
        hosts: input.grant?.hosts,
        message: input.message,
      });
    }
    // The refusal is answered first and in full; the activity log row is written alongside it and
    // a failed write is only logged, never a reason to change the answer.
    if (this.#audit !== null && input.grant !== undefined && input.auditDescription !== undefined) {
      const grant = input.grant;
      const description = input.auditDescription;
      void this.#audit
        .record({
          tenant_id: grant.tenant_id,
          created_by: grant.created_by,
          conversation_id: grant.session_id,
          tier: 3,
          tool_name: 'skill_network',
          description,
          outcome: 'auto_denied',
          auto_deny_reason: null,
        })
        .catch((error: unknown) => {
          this.#logger.warn('Could not record a refused skill network connection in the activity log', {
            host: input.host,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    const body = `${input.message}\n`;
    input.socket.end(
      `HTTP/1.1 ${String(input.status)} Refused\r\nContent-Type: text/plain\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`,
    );
  }
}

/** Splits a CONNECT authority (`host:port`) into its parts, or undefined when it is not one. */
function parseConnectTarget(authority: string | undefined): { host: string; port: number } | undefined {
  if (authority === undefined) {
    return undefined;
  }
  const mark = authority.lastIndexOf(':');
  if (mark <= 0) {
    return undefined;
  }
  const host = authority.slice(0, mark).toLowerCase();
  const port = Number(authority.slice(mark + 1));
  if (host.length === 0 || host.includes('/') || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return { host, port };
}

/** Opens a TCP connection to a public address of the host, resolved and pinned by the guarded lookup. */
function dialPublicHost(input: { host: string; port: number }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({
      host: input.host,
      port: input.port,
      lookup: guardedLookup,
      timeout: CONNECT_TIMEOUT_MS,
    });
    socket.once('connect', () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once('timeout', () => {
      socket.destroy(new Error(`Connecting to ${input.host} took too long.`));
    });
    socket.once('error', reject);
  });
}
