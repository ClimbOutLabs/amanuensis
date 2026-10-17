import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';

function openssl(input: { root: string; args: string[] }): void {
  execFileSync('/usr/bin/openssl', input.args, { cwd: input.root, stdio: 'ignore' });
}

/** A test CA (`ca.crt`) and a github.com leaf in `root`, so the stand-in for GitHub passes git's certificate check. */
export function makeCerts(root: string): void {
  openssl({
    root,
    args: ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=t'],
  });
  openssl({
    root,
    args: ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=github.com'],
  });
  writeFileSync(join(root, 'ext.cnf'), 'subjectAltName=DNS:github.com\n');
  openssl({
    root,
    args: [
      'x509',
      '-req',
      '-in',
      'srv.csr',
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'srv.crt',
      '-days',
      '2',
      '-extfile',
      'ext.cnf',
    ],
  });
}

export interface SeenRequest {
  path: string;
  authorization: string | undefined;
}

/** A CONNECT proxy that answers as github.com, asks for credentials until it gets them, and records every request. */
export async function fakeGithub(
  root: string,
): Promise<{ port: number; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const key = readFileSync(join(root, 'srv.key'));
  const cert = readFileSync(join(root, 'srv.crt'));
  const server = createServer((socket: Socket) => {
    socket.on('error', () => undefined);
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const tls = new TLSSocket(socket, { isServer: true, key, cert, ALPNProtocols: ['http/1.1'] });
      tls.on('error', () => undefined);
      let buffer = '';
      tls.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('latin1');
        for (let end = buffer.indexOf('\r\n\r\n'); end !== -1; end = buffer.indexOf('\r\n\r\n')) {
          const [requestLine, ...headers] = buffer.slice(0, end).split('\r\n');
          buffer = buffer.slice(end + 4);
          const authorization = headers.find(header => /^authorization:/iu.test(header))?.split(': ')[1];
          seen.push({ path: requestLine?.split(' ')[1] ?? '', authorization });
          tls.write(
            authorization === undefined
              ? 'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="GitHub"\r\nContent-Length: 2\r\n\r\nno'
              : 'HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\nno',
          );
        }
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake GitHub has no port');
  }
  return {
    port: address.port,
    seen,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
