import type { ServerType } from '@hono/node-server';

/** The port a test server listens on, once it is listening. */
export async function listeningPort(server: ServerType): Promise<number> {
  if (!server.listening) {
    await new Promise<void>(resolve => {
      server.once('listening', () => {
        resolve();
      });
    });
  }
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server has no port.');
  }
  return address.port;
}

/** Stops a test server and drops any connection still open, so a test never waits on a kept-alive socket. */
export function closeServer(server: ServerType): Promise<void> {
  return new Promise<void>(resolve => {
    server.close(() => {
      resolve();
    });
    if ('closeAllConnections' in server) {
      server.closeAllConnections();
    }
  });
}
