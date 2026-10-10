import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { processDeps } from '../../../../src/cli/doctor/deps';
import { errorCode } from '../../../../src/cli/errorCode';

const deps = processDeps();
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'aman-doctor-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('real doctor dependencies', () => {
  it('probes a writable database without changing it', async () => {
    const file = path.join(scratch, 'db.sqlite');
    const db = new Database(file);
    db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('keep')");
    db.close();
    deps.probeDatabaseWritable({ path: file, timeoutMs: 500 });
    const after = new Database(file, { readonly: true });
    expect(after.prepare('SELECT v FROM t').all()).toEqual([{ v: 'keep' }]);
    after.close();
  });

  it('rejects a database that does not exist instead of creating it', async () => {
    const file = path.join(scratch, 'missing.sqlite');
    expect(() => {
      deps.probeDatabaseWritable({ path: file, timeoutMs: 100 });
    }).toThrow();
    expect(existsSync(file)).toBe(false);
    await expect(deps.freeBytes(file)).rejects.toThrow();
  });

  it('rejects while another connection holds the write lock', async () => {
    const file = path.join(scratch, 'db.sqlite');
    const holder = new Database(file);
    holder.exec('CREATE TABLE t (v TEXT); BEGIN IMMEDIATE');
    let error: unknown;
    try {
      deps.probeDatabaseWritable({ path: file, timeoutMs: 50 });
    } catch (caught) {
      error = caught;
    }
    holder.close();
    expect(errorCode(error)).toBe('SQLITE_BUSY');
  });

  it('reports free bytes of a directory', async () => {
    expect(await deps.freeBytes(scratch)).toBeGreaterThan(0);
  });

  describe('get', () => {
    let server: Server;
    let base: string;

    beforeEach(async () => {
      server = createServer((req, res) => {
        if (req.url === '/json') {
          res.setHeader('content-type', 'application/json');
          res.end('{"issuer":"x"}');
        } else if (req.url === '/text') {
          res.statusCode = 503;
          res.end('down');
        } else {
          setTimeout(() => res.end('late'), 2000).unref();
        }
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('server has no TCP address');
      }
      base = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });

    it('returns status, the Date header and parsed JSON', async () => {
      const result = await deps.get({ url: `${base}/json`, timeoutMs: 1000 });
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ issuer: 'x' });
      expect(Number.isNaN(Date.parse(result.date ?? ''))).toBe(false);
    });

    it('returns an error status with undefined JSON for a non-JSON body', async () => {
      const result = await deps.get({ url: `${base}/text`, timeoutMs: 1000 });
      expect(result).toMatchObject({ status: 503, json: undefined });
    });

    it('rejects when the server does not answer in time', async () => {
      await expect(deps.get({ url: `${base}/slow`, timeoutMs: 100 })).rejects.toThrow();
    });
  });
});
