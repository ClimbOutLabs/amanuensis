import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

import type { ViteDevServer } from 'vite';

const KEPT_NOTES = 12;

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps short notes on what a dev server did to its connections. A dropped request is rare and has
 * not been caught on a desk, so the test that hits one reports these instead of a bare reset.
 */
export function watchConnections(server: NonNullable<ViteDevServer['httpServer']>): () => string {
  const started = Date.now();
  const notes: string[] = [];
  const note = (text: string): void => {
    notes.push(`+${String(Date.now() - started)}ms ${text}`);
    if (notes.length > KEPT_NOTES) notes.shift();
  };
  const lastUse = new WeakMap<Socket, { at: number; served: number }>();
  let open = 0;

  server.on('connection', (socket: Socket) => {
    open += 1;
    lastUse.set(socket, { at: Date.now(), served: 0 });
    socket.on('error', (error: unknown) => note(`a connection failed: ${codeOf(error)}`));
    socket.on('close', () => {
      open -= 1;
      const use = lastUse.get(socket);
      if (use === undefined) return;
      note(`a connection closed after ${String(use.served)} requests, ${String(Date.now() - use.at)}ms idle`);
    });
  });
  server.on('request', (request: IncomingMessage) => {
    const use = lastUse.get(request.socket);
    if (use === undefined) return;
    use.at = Date.now();
    use.served += 1;
  });
  server.on('clientError', (error: unknown) => note(`the server refused a request: ${codeOf(error)}`));
  server.on('close', () => note('the server closed'));

  return () => `${String(open)} connections open; ${notes.length === 0 ? 'nothing noted' : notes.join('; ')}`;
}
