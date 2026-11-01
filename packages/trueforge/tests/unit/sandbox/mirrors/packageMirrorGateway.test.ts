import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, transports } from 'winston';
import type { PackageMirrorAllowanceCheck } from '../../../../src/sandbox/mirrors/packageMirrorAllowance';
import {
  PackageMirrorGateway,
  isPublicAddress,
  isSafeMirrorPath,
} from '../../../../src/sandbox/mirrors/packageMirrorGateway';
import { PackageMirrorTokenRegistry } from '../../../../src/sandbox/mirrors/packageMirrorTokens';

const silentLogger = createLogger({ transports: [new transports.Console({ silent: true })] });

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}

function call(port: number, input: { method?: string; path: string; token?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: input.path, method: input.method ?? 'GET' }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
      });
    });
    req.once('error', reject);
    if (input.token !== undefined) {
      req.setHeader('x-aman-mirror-token', input.token);
    }
    req.end();
  });
}

interface Harness {
  gateway: PackageMirrorGateway;
  registry: PackageMirrorTokenRegistry;
  token: string;
  port: number;
  upstreamHits: string[];
  otherHits: string[];
  cacheDir: string;
  close: () => Promise<void>;
}

async function setup(options?: {
  maxDownloadBytes?: number;
  maxCacheBytes?: number;
  allowanceHolds?: PackageMirrorAllowanceCheck;
}): Promise<Harness> {
  const upstreamHits: string[] = [];
  const otherHits: string[] = [];
  let upstreamPort = 0;
  let otherPort = 0;
  const other = createServer((req, res) => {
    const url = req.url ?? '/';
    otherHits.push(`${req.method ?? ''} ${url}`);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`other server saw ${url}`);
  });
  const upstream = createServer((req, res) => {
    const url = req.url ?? '/';
    upstreamHits.push(`${req.method ?? ''} ${url}`);
    const origin = `http://127.0.0.1:${String(upstreamPort)}`;
    if (url === '/leftpad') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: 'leftpad',
          versions: { '1.0.0': { dist: { tarball: `${origin}/leftpad/-/leftpad-1.0.0.tgz` } } },
        }),
      );
      return;
    }
    if (url === '/leftpad/-/leftpad-1.0.0.tgz') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end('fake tarball bytes');
      return;
    }
    if (url === '/evilpkg') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: 'evilpkg',
          versions: { '9.9.9': { dist: { tarball: 'https://evil.example.net/evil-9.9.9.tgz' } } },
        }),
      );
      return;
    }
    if (url === '/sneakypkg') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: 'sneakypkg',
          versions: {
            '1.0.0': { dist: { tarball: 'http://127.0.0.1@evil.example.net/u-1.0.0.tgz' } },
            '2.0.0': { dist: { tarball: 'http://someone@evil.example.net/u-2.0.0.tgz' } },
            '3.0.0': { dist: { tarball: 'https://127.0.0.1.evil.example.net/u-3.0.0.tgz' } },
          },
        }),
      );
      return;
    }
    if (url === '/simple/requests/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<a href="${origin}/packages/aa/requests-2.0-py3-none-any.whl#sha256=abc">requests</a>`);
      return;
    }
    if (url === '/packages/aa/requests-2.0-py3-none-any.whl') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end('fake wheel bytes');
      return;
    }
    if (url === '/redir-off') {
      res.writeHead(302, { location: 'https://evil.example.net/stolen' });
      res.end();
      return;
    }
    if (url === '/redir-on') {
      res.writeHead(302, { location: `${origin}/simple/requests/` });
      res.end();
      return;
    }
    if (url === '/redir-user') {
      res.writeHead(302, { location: `http://someone@${origin.slice('http://'.length)}/simple/requests/` });
      res.end();
      return;
    }
    if (url === '/redir-pass') {
      res.writeHead(302, { location: `http://someone:secret@${origin.slice('http://'.length)}/simple/requests/` });
      res.end();
      return;
    }
    if (url === '/redir-other-port') {
      res.writeHead(302, { location: `http://127.0.0.1:${String(otherPort)}/simple/requests/` });
      res.end();
      return;
    }
    if (url === '/big') {
      const body = Buffer.alloc(4096, 1);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
      res.end(body);
      return;
    }
    if (url.startsWith('/crates/') || url.startsWith('/@scope') || url.startsWith('/sumdb/')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(`upstream saw ${url}`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream saw ${url}`);
  });
  upstreamPort = await listen(upstream);
  otherPort = await listen(other);
  const upstreamBase = `http://127.0.0.1:${String(upstreamPort)}`;
  const registry = new PackageMirrorTokenRegistry();
  const token = registry.issue({
    tenant_id: 'tenant-1',
    created_by: 'owner-1',
    session_id: 'session-1',
    repository_id: 'repo-1',
  });
  const cacheDir = mkdtempSync(join(tmpdir(), 'aman-mirror-test-'));
  const gateway = new PackageMirrorGateway({
    registry,
    allowanceHolds: options?.allowanceHolds ?? (() => Promise.resolve(true)),
    cacheDir,
    logger: silentLogger,
    upstreamBases: {
      pypi: [upstreamBase, upstreamBase],
      npm: [upstreamBase],
      go: [upstreamBase],
      cargo: [upstreamBase, upstreamBase],
    },
    ...(options?.maxDownloadBytes === undefined ? {} : { maxDownloadBytes: options.maxDownloadBytes }),
    ...(options?.maxCacheBytes === undefined ? {} : { maxCacheBytes: options.maxCacheBytes }),
  });
  const server = createServer(gateway.handler);
  const port = await listen(server);
  return {
    gateway,
    registry,
    token,
    port,
    upstreamHits,
    otherHits,
    cacheDir,
    close: async () => {
      await closeServer(server);
      await closeServer(upstream);
      await closeServer(other);
    },
  };
}

describe('PackageMirrorGateway', () => {
  it('refuses a publish and stores nothing', async () => {
    const harness = await setup();
    try {
      const reply = await call(harness.port, {
        method: 'PUT',
        path: '/npm/leftpad',
        token: harness.token,
      });
      expect(reply.status).toBe(405);
      expect(reply.headers['allow']).toBe('GET, HEAD');
      expect(harness.upstreamHits).toEqual([]);
      expect(readdirSync(harness.cacheDir)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('refuses a POST to the PyPI mirror and stores nothing', async () => {
    const harness = await setup();
    try {
      const reply = await call(harness.port, {
        method: 'POST',
        path: '/pypi/',
        token: harness.token,
      });
      expect(reply.status).toBe(405);
      expect(reply.headers['allow']).toBe('GET, HEAD');
      expect(harness.upstreamHits).toEqual([]);
      expect(readdirSync(harness.cacheDir)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('sends links carrying userinfo to the refusal path whole, like other off-list links', async () => {
    const harness = await setup();
    try {
      const metadata = await call(harness.port, { path: '/npm/sneakypkg', token: harness.token });
      expect(metadata.status).toBe(200);
      expect(metadata.body).toContain(`/m/${harness.token}/npm/off-list/evil.example.net/u-1.0.0.tgz`);
      expect(metadata.body).toContain(`/m/${harness.token}/npm/off-list/evil.example.net/u-2.0.0.tgz`);
      expect(metadata.body).toContain(`/m/${harness.token}/npm/off-list/127.0.0.1.evil.example.net/u-3.0.0.tgz`);
      expect(metadata.body).not.toContain('@evil.example.net');
      const refused = await call(harness.port, {
        path: '/npm/off-list/evil.example.net/u-1.0.0.tgz',
        token: harness.token,
      });
      expect(refused.status).toBe(403);
      expect(harness.upstreamHits.some(hit => hit.includes('u-1.0.0'))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('refuses requests without a known token', async () => {
    const harness = await setup();
    try {
      expect((await call(harness.port, { path: '/npm/leftpad' })).status).toBe(403);
      expect(
        (await call(harness.port, { path: '/npm/leftpad', token: 'ffffffffffffffffffffffffffffffff' })).status,
      ).toBe(403);
      expect(harness.upstreamHits).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('stops a grant whose allowance no longer holds in the shared database, and takes it back', async () => {
    const harness = await setup({ allowanceHolds: () => Promise.resolve(false) });
    try {
      const refused = await call(harness.port, { path: '/npm/leftpad', token: harness.token });
      expect(refused.status).toBe(403);
      expect(refused.body).toContain('Package downloads were turned off for this chat');
      expect(harness.registry.resolve(harness.token)).toBeUndefined();
      expect(harness.upstreamHits).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('serves npm metadata with tarball links rewritten to the mirror, then the tarball itself', async () => {
    const harness = await setup();
    try {
      const metadata = await call(harness.port, { path: '/npm/leftpad', token: harness.token });
      expect(metadata.status).toBe(200);
      expect(metadata.body).toContain(`/m/${harness.token}/npm/leftpad/-/leftpad-1.0.0.tgz`);
      const tarball = await call(harness.port, {
        path: '/npm/leftpad/-/leftpad-1.0.0.tgz',
        token: harness.token,
      });
      expect(tarball.status).toBe(200);
      expect(tarball.body).toBe('fake tarball bytes');
      const hitsBefore = harness.upstreamHits.filter(hit => hit.includes('leftpad-1.0.0.tgz')).length;
      const again = await call(harness.port, {
        path: '/npm/leftpad/-/leftpad-1.0.0.tgz',
        token: harness.token,
      });
      expect(again.status).toBe(200);
      expect(again.body).toBe('fake tarball bytes');
      expect(harness.upstreamHits.filter(hit => hit.includes('leftpad-1.0.0.tgz')).length).toBe(hitsBefore);
    } finally {
      await harness.close();
    }
  });

  it('fails a package whose metadata points to another site', async () => {
    const harness = await setup();
    try {
      const metadata = await call(harness.port, { path: '/npm/evilpkg', token: harness.token });
      expect(metadata.status).toBe(200);
      expect(metadata.body).not.toContain('https://evil.example.net/evil-9.9.9.tgz');
      expect(metadata.body).toContain('/off-list/evil.example.net/');
      const refused = await call(harness.port, {
        path: '/npm/off-list/evil.example.net/evil-9.9.9.tgz',
        token: harness.token,
      });
      expect(refused.status).toBe(403);
      expect(harness.upstreamHits.some(hit => hit.includes('evil-9.9.9'))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('refuses a redirect off the list and follows one that stays on it', async () => {
    const harness = await setup();
    try {
      const off = await call(harness.port, { path: '/pypi/redir-off', token: harness.token });
      expect(off.status).toBe(502);
      const on = await call(harness.port, { path: '/pypi/redir-on', token: harness.token });
      expect(on.status).toBe(200);
      expect(on.body).toContain('requests-2.0-py3-none-any.whl');
    } finally {
      await harness.close();
    }
  });

  it('refuses a redirect carrying a user name, without contacting its target', async () => {
    const harness = await setup();
    try {
      const reply = await call(harness.port, { path: '/pypi/redir-user', token: harness.token });
      expect(reply.status).toBe(502);
      expect(harness.upstreamHits).toEqual(['GET /redir-user']);
    } finally {
      await harness.close();
    }
  });

  it('refuses a redirect carrying a password, without contacting its target', async () => {
    const harness = await setup();
    try {
      const reply = await call(harness.port, { path: '/pypi/redir-pass', token: harness.token });
      expect(reply.status).toBe(502);
      expect(harness.upstreamHits).toEqual(['GET /redir-pass']);
    } finally {
      await harness.close();
    }
  });

  it('refuses a redirect to another port on the same host', async () => {
    const harness = await setup();
    try {
      const reply = await call(harness.port, { path: '/pypi/redir-other-port', token: harness.token });
      expect(reply.status).toBe(502);
      expect(harness.upstreamHits).toEqual(['GET /redir-other-port']);
      expect(harness.otherHits).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('serves a PyPI simple page and the wheel it links to', async () => {
    const harness = await setup();
    try {
      const page = await call(harness.port, { path: '/pypi/simple/requests/', token: harness.token });
      expect(page.status).toBe(200);
      expect(page.body).toContain(`/m/${harness.token}/pypi/packages/aa/requests-2.0-py3-none-any.whl#sha256=abc`);
      const wheel = await call(harness.port, {
        path: '/pypi/packages/aa/requests-2.0-py3-none-any.whl',
        token: harness.token,
      });
      expect(wheel.status).toBe(200);
      expect(wheel.body).toBe('fake wheel bytes');
    } finally {
      await harness.close();
    }
  });

  it('routes PyPI file downloads to the files upstream', async () => {
    const harness = await setup();
    try {
      const reply = await call(harness.port, {
        path: '/pypi/files/packages/aa/requests-2.0-py3-none-any.whl',
        token: harness.token,
      });
      expect(reply.status).toBe(200);
      expect(reply.body).toBe('fake wheel bytes');
      expect(harness.upstreamHits).toContain('GET /packages/aa/requests-2.0-py3-none-any.whl');
    } finally {
      await harness.close();
    }
  });

  it('rejects path tricks and still carries an encoded scoped npm name', async () => {
    const harness = await setup();
    try {
      expect((await call(harness.port, { path: '/npm/%2e%2e/secret', token: harness.token })).status).toBe(404);
      expect((await call(harness.port, { path: '/npm/..%2fsecret', token: harness.token })).status).toBe(404);
      const scoped = await call(harness.port, { path: '/npm/@scope%2fpkg', token: harness.token });
      expect(scoped.status).toBe(200);
      expect(scoped.body).toBe('upstream saw /@scope%2fpkg');
      expect(harness.upstreamHits.some(hit => hit.includes('secret'))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('serves Go module and checksum database paths', async () => {
    const harness = await setup();
    try {
      const info = await call(harness.port, {
        path: '/go/example.com/mod/@v/v1.0.0.info',
        token: harness.token,
      });
      expect(info.status).toBe(200);
      const sum = await call(harness.port, {
        path: '/go/sumdb/sum.golang.org/lookup/example.com/mod@v1.0.0',
        token: harness.token,
      });
      expect(sum.status).toBe(200);
      expect(sum.body).toBe('upstream saw /sumdb/sum.golang.org/lookup/example.com/mod@v1.0.0');
    } finally {
      await harness.close();
    }
  });

  it('serves the cargo index config, an index file and a crate download', async () => {
    const harness = await setup();
    try {
      const config = await call(harness.port, { path: '/cargo/config.json', token: harness.token });
      expect(config.status).toBe(200);
      expect(config.body).toContain(`/m/${harness.token}/cargo/dl/{crate}/{version}`);
      const index = await call(harness.port, { path: '/cargo/se/rd/serde', token: harness.token });
      expect(index.status).toBe(200);
      const crate = await call(harness.port, { path: '/cargo/dl/serde/1.0.0', token: harness.token });
      expect(crate.status).toBe(200);
      expect(crate.body).toBe('upstream saw /crates/serde/serde-1.0.0.crate');
    } finally {
      await harness.close();
    }
  });

  it('refuses a download larger than the per-download cap', async () => {
    const harness = await setup({ maxDownloadBytes: 128 });
    try {
      const reply = await call(harness.port, { path: '/npm/big', token: harness.token });
      expect(reply.status).toBe(413);
      expect(readdirSync(harness.cacheDir).filter(name => name.endsWith('.body'))).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('keeps the cache within its total cap', async () => {
    const harness = await setup({ maxCacheBytes: 32 });
    try {
      for (const name of ['one', 'two', 'three']) {
        const reply = await call(harness.port, { path: `/npm/${name}`, token: harness.token });
        expect(reply.status).toBe(200);
      }
      // Cache pruning runs after each store; wait until what is left fits the cap.
      let total = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 40 && total > 32; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
        total = readdirSync(harness.cacheDir)
          .filter(name => name.endsWith('.body'))
          .reduce((sum, name) => sum + statSync(join(harness.cacheDir, name)).size, 0);
      }
      expect(total).toBeLessThanOrEqual(32);
    } finally {
      await harness.close();
    }
  });
});

describe('isSafeMirrorPath', () => {
  it.each(['/npm/leftpad', '/pypi/simple/requests/', '/npm/@scope%2fpkg', '/go/example.com/mod/@v/list'])(
    'allows %s',
    rawPath => {
      expect(isSafeMirrorPath(rawPath)).toBe(true);
    },
  );
  it.each(['/npm/../secret', '/npm/%2e%2e/secret', '/npm/%2E%2E%2Fsecret', '/npm/a%5cb', 'npm/leftpad', '/npm/%zz'])(
    'refuses %s',
    rawPath => {
      expect(isSafeMirrorPath(rawPath)).toBe(false);
    },
  );
});

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '151.101.0.223', '172.15.0.1', '2606:4700:4700::1111', '2001:4860::1'])(
    'treats %s as public',
    address => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '192.168.1.1',
    '172.16.0.1',
    '169.254.1.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    'not-an-ip',
  ])('treats %s as not public', address => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe('PackageMirrorGateway sockets', () => {
  function callSocket(socketPath: string, input: { path: string }): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ socketPath, path: input.path, method: 'GET' }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
        });
      });
      req.once('error', reject);
      req.end();
    });
  }

  it('opens each mirror socket so the slot agent, which runs as another user, can connect to it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aman-mirror-socket-'));
    const socketPath = join(dir, 'mirror.sock');
    const gateway = new PackageMirrorGateway({
      registry: new PackageMirrorTokenRegistry(),
      allowanceHolds: () => Promise.resolve(true),
      cacheDir: join(dir, 'cache'),
      logger: silentLogger,
    });
    await gateway.listenOnSockets([socketPath]);
    try {
      // Connecting to a Unix socket needs write permission on the socket file itself. The slot
      // agent runs as a different user than the app, so a socket left at the umask default (0755,
      // owner only) refuses it; the gateway must open the socket beyond its owner.
      expect(statSync(socketPath).mode & 0o777).toBe(0o666);
      const reply = await callSocket(socketPath, { path: '/npm/leftpad' });
      expect(reply.status).toBe(403);
    } finally {
      await gateway.close();
    }
  });
});

describe('PackageMirrorTokenRegistry', () => {
  const input = { tenant_id: 't', created_by: 'o', session_id: 's', repository_id: 'r' };

  it('issues a stable token per chat and repo and resolves it', () => {
    const registry = new PackageMirrorTokenRegistry();
    const first = registry.issue(input);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(registry.issue(input)).toBe(first);
    expect(registry.resolve(first)?.repository_id).toBe('r');
    expect(registry.resolve('0'.repeat(32))).toBeUndefined();
  });

  it('revokes by repository and by session', () => {
    const registry = new PackageMirrorTokenRegistry();
    const token = registry.issue(input);
    registry.revokeRepository({ tenant_id: 't', created_by: 'o', repository_id: 'r' });
    expect(registry.resolve(token)).toBeUndefined();
    const second = registry.issue(input);
    registry.revokeSession('s');
    expect(registry.resolve(second)).toBeUndefined();
  });
});

describe('PackageMirrorGateway with a grant for a chat without a project', () => {
  function issueWithoutProject(harness: Harness): string {
    return harness.registry.issue({ tenant_id: 'tenant-1', created_by: 'owner-1', session_id: 'session-2' });
  }

  it('serves downloads through the mirror on a project-less grant', async () => {
    const harness = await setup();
    try {
      const token = issueWithoutProject(harness);
      const metadata = await call(harness.port, { path: '/npm/leftpad', token });
      expect(metadata.status).toBe(200);
      const tarball = await call(harness.port, { path: '/npm/leftpad/-/leftpad-1.0.0.tgz', token });
      expect(tarball.status).toBe(200);
      expect(tarball.body).toBe('fake tarball bytes');
      const wheel = await call(harness.port, { path: '/pypi/simple/requests/', token });
      expect(wheel.status).toBe(200);
    } finally {
      await harness.close();
    }
  });

  it('refuses publishing and uploads on a project-less grant', async () => {
    const harness = await setup();
    try {
      const token = issueWithoutProject(harness);
      const npmPublish = await call(harness.port, { method: 'PUT', path: '/npm/leftpad', token });
      expect(npmPublish.status).toBe(405);
      const pythonUpload = await call(harness.port, { method: 'POST', path: '/pypi/', token });
      expect(pythonUpload.status).toBe(405);
      const cargoPublish = await call(harness.port, { method: 'POST', path: '/cargo/api/v1/crates/new', token });
      expect(cargoPublish.status).toBe(405);
      expect(harness.upstreamHits).toEqual([]);
      expect(readdirSync(harness.cacheDir)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('refuses an address that is not a package mirror, and a redirect off the list', async () => {
    const harness = await setup();
    try {
      const token = issueWithoutProject(harness);
      const unknown = await call(harness.port, { path: '/evil.example.net/leftpad.tgz', token });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toContain('There is no package mirror at that address.');
      const offList = await call(harness.port, { path: '/pypi/redir-off', token });
      expect(offList.status).toBe(502);
      const offListPath = await call(harness.port, {
        path: '/npm/off-list/evil.example.net/evil-9.9.9.tgz',
        token,
      });
      expect(offListPath.status).toBe(403);
    } finally {
      await harness.close();
    }
  });

  it('stops serving a project-less grant the moment it is taken back', async () => {
    const harness = await setup();
    try {
      const token = issueWithoutProject(harness);
      expect((await call(harness.port, { path: '/npm/leftpad', token })).status).toBe(200);
      harness.registry.revokePersonWithoutRepository({ tenant_id: 'tenant-1', created_by: 'owner-1' });
      const refused = await call(harness.port, { path: '/npm/leftpad', token });
      expect(refused.status).toBe(403);
      expect(refused.body).toContain('Allow package downloads in this chat first');
      // The repository grant of the same person keeps working.
      expect((await call(harness.port, { path: '/npm/leftpad', token: harness.token })).status).toBe(200);
    } finally {
      await harness.close();
    }
  });
});
