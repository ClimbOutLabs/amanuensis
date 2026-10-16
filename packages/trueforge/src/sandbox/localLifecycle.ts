import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Logger } from 'winston';

const SOCKET_PARENT_MODE = 0o700;

/**
 * Check whether a TCP port is free on loopback. Used as a safety gate: if the
 * port is in use, another instance is likely live in this socket folder, so we
 * must not delete it.
 */
async function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, '127.0.0.1');
  });
}

/** Exists → warn, then rm + mkdir 0700. Reliability path for leftover UDS files (including watch restarts). */
export async function prepareCodeModeSocketParent(params: {
  path: string;
  logger: Logger;
  port?: number;
}): Promise<void> {
  if (existsSync(params.path)) {
    if (params.port !== undefined && !(await isLoopbackPortFree(params.port))) {
      throw new Error(
        `Code Mode socket parent ${params.path} exists and port ${String(params.port)} is in use; ` +
          'another instance may be running. Refusing to remove its sockets.',
      );
    }
    params.logger.warn('Removing leftover Code Mode socket parent', { path: params.path });
    await rm(params.path, { recursive: true, force: true });
  }
  await mkdir(params.path, { recursive: true, mode: SOCKET_PARENT_MODE });
}

export async function removeCodeModeSocketParent(socketParentPath: string): Promise<void> {
  await rm(socketParentPath, { recursive: true, force: true });
}

export async function ensureLocalSandboxRootParent(sandboxRootPathParent: string): Promise<void> {
  await mkdir(sandboxRootPathParent, { recursive: true, mode: SOCKET_PARENT_MODE });
}
