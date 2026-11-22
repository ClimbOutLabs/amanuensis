import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ADDRESS_NOT_LISTED_HEADERS,
  addressAddCommand,
  addressNotListedPage,
  createRefusedAddressLog,
  ownPortsOf,
} from '../../../src/auth/addressNotListedPage';

const OWN = new Set(['8791', '8443']);

describe('addressAddCommand', () => {
  it('adds a name of this computer by itself when it came on one of the instance ports', () => {
    expect(addressAddCommand({ hostHeader: 'Spark.lan:8443', ownPorts: OWN })).toBe('aman address add spark.lan');
  });

  it('adds the full address of a forward that came on another port or none', () => {
    expect(addressAddCommand({ hostHeader: 'aman.example.ts.net', ownPorts: OWN })).toBe(
      'aman address add https://aman.example.ts.net',
    );
    expect(addressAddCommand({ hostHeader: 'proxy.lan:9000', ownPorts: OWN })).toBe(
      'aman address add https://proxy.lan:9000',
    );
  });

  it('names no address it cannot read safely', () => {
    expect(addressAddCommand({ hostHeader: 'a b"', ownPorts: OWN })).toBe('aman address add <the address you opened>');
  });
});

describe('addressNotListedPage', () => {
  it('runs only its own script', () => {
    const page = addressNotListedPage({ hostHeader: 'aman.example.ts.net', ownPorts: OWN });
    const script = /<script>([\s\S]*)<\/script>/.exec(page)?.[1] ?? '';
    expect(ADDRESS_NOT_LISTED_HEADERS['content-security-policy']).toContain(
      `'sha256-${createHash('sha256').update(script).digest('base64')}'`,
    );
  });
});

describe('ownPortsOf', () => {
  it('takes the ports the listed addresses name, never a default one', () => {
    expect([
      ...ownPortsOf({
        publicBaseUrl: 'http://127.0.0.1:8791',
        allowedOrigins: ['https://192.168.1.20:8443', 'https://aman.example.ts.net'],
      }),
    ]).toEqual(['8791', '8443']);
  });
});

describe('createRefusedAddressLog', () => {
  it('keeps the last ten hosts, each once, and never a host it cannot read safely', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'refused-'));
    const file = path.join(dir, 'refused-addresses.txt');
    const record = createRefusedAddressLog(file);
    for (let i = 0; i < 12; i += 1) {
      record(`host${String(i)}.lan`);
    }
    record('host11.lan');
    await record('bad host');
    const hosts = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map(line => line.split(' ')[1]);
    expect(hosts).toEqual(Array.from({ length: 10 }, (_, i) => `host${String(i + 2)}.lan`));
  });
});
