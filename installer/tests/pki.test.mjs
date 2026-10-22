import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { ensureCa, info, issueLeaf, LEAF_DAYS, leafIsCurrent, RENEW_BEFORE_DAYS } from '../lib/pki.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NAMES = ['192.168.1.20', '127.0.0.1', 'host.local', 'localhost'];
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

describe('the local certificate authority', () => {
  let dir;
  const fresh = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'aman-pki-'));
    return { caDir: path.join(dir, 'ca'), leafDir: path.join(dir, 'leaf') };
  };
  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makes a root that lasts years, keeps its key to its owner, and makes it only once', () => {
    const { caDir } = fresh();
    const first = ensureCa({ caDir, names: NAMES });
    assert.equal(first.created, true);
    assert.equal(statSync(path.join(caDir, 'root.key')).mode & 0o777, 0o600);
    const root = new X509Certificate(readFileSync(path.join(caDir, 'root.crt')));
    assert.ok(root.ca);
    assert.ok(root.validToDate.getTime() - Date.now() > 9 * 365 * DAY);
    const before = readFileSync(path.join(caDir, 'root.key'), 'utf8');
    assert.equal(ensureCa({ caDir, names: NAMES }).created, false);
    assert.equal(readFileSync(path.join(caDir, 'root.key'), 'utf8'), before);
  });

  it('makes a new authority when the old one is about to end, and the leaf then follows the new one', () => {
    const { caDir, leafDir } = fresh();
    ensureCa({ caDir, names: NAMES });
    issueLeaf({ caDir, leafDir, names: NAMES });
    const old = readFileSync(path.join(caDir, 'root.crt'), 'utf8');
    const later = new Date(Date.now() + (365 * 10 - 10) * DAY);
    assert.equal(ensureCa({ caDir, now: later }).created, true);
    assert.notEqual(readFileSync(path.join(caDir, 'root.crt'), 'utf8'), old);
    assert.equal(leafIsCurrent({ caDir, leafDir, names: NAMES }), false);
    assert.equal(issueLeaf({ caDir, leafDir, names: NAMES }).issued, true);
  });

  it('issues one leaf for every address and name, signed by the root, for no more than 397 days', () => {
    const { caDir, leafDir } = fresh();
    ensureCa({ caDir, names: NAMES });
    assert.equal(issueLeaf({ caDir, leafDir, names: NAMES }).issued, true);
    const leaf = new X509Certificate(readFileSync(path.join(leafDir, 'leaf.crt')));
    const root = new X509Certificate(readFileSync(path.join(caDir, 'root.crt')));
    assert.ok(leaf.verify(root.publicKey));
    assert.ok(!leaf.ca);
    const days = (leaf.validToDate.getTime() - leaf.validFromDate.getTime()) / DAY;
    assert.ok(days <= LEAF_DAYS + 1, `valid for ${String(days)} days`);
    assert.deepEqual(info({ caDir, leafDir }).leaf_names, [...NAMES].sort());
    assert.ok(info({ caDir, leafDir }).leaf_days_left >= LEAF_DAYS - 1);
    assert.ok(info({ caDir, leafDir }).root_days_left > 3000);
    assert.equal(statSync(path.join(leafDir, 'leaf.key')).mode & 0o777, 0o600);
  });

  it('leaves a good leaf alone, and issues again for other names or when it is about to end', () => {
    const { caDir, leafDir } = fresh();
    ensureCa({ caDir, names: NAMES });
    issueLeaf({ caDir, leafDir, names: NAMES });
    const key = readFileSync(path.join(leafDir, 'leaf.key'), 'utf8');
    assert.equal(issueLeaf({ caDir, leafDir, names: NAMES }).issued, false);
    assert.equal(readFileSync(path.join(leafDir, 'leaf.key'), 'utf8'), key);
    assert.equal(issueLeaf({ caDir, leafDir, names: [...NAMES, '192.168.1.77'] }).issued, true);
    const soon = new Date(Date.now() + (LEAF_DAYS - RENEW_BEFORE_DAYS + 1) * DAY);
    assert.equal(leafIsCurrent({ caDir, leafDir, names: [...NAMES, '192.168.1.77'], now: soon }), false);
    assert.equal(issueLeaf({ caDir, leafDir, names: [...NAMES, '192.168.1.77'], now: soon }).issued, true);
  });

  it('is accepted by a client that trusts only the root, for an address typed into the browser', async () => {
    const { caDir, leafDir } = fresh();
    ensureCa({ caDir, names: NAMES });
    issueLeaf({ caDir, leafDir, names: NAMES });
    const server = https.createServer(
      { key: readFileSync(path.join(leafDir, 'leaf.key')), cert: readFileSync(path.join(leafDir, 'leaf.crt')) },
      (_request, response) => response.end('hello'),
    );
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const body = await new Promise((resolve, reject) => {
      https
        .get(
          { host: '127.0.0.1', port: server.address().port, ca: readFileSync(path.join(caDir, 'root.crt')) },
          response => {
            let text = '';
            response.on('data', chunk => (text += chunk));
            response.on('end', () => resolve(text));
          },
        )
        .on('error', reject);
    });
    server.close();
    assert.equal(body, 'hello');
    // A name the leaf does not list is refused, as a browser would.
    const refused = await new Promise(resolve => {
      const s = https.createServer(
        { key: readFileSync(path.join(leafDir, 'leaf.key')), cert: readFileSync(path.join(leafDir, 'leaf.crt')) },
        (_q, r) => r.end('x'),
      );
      s.listen(0, '127.0.0.1', () => {
        https
          .get(
            {
              host: '127.0.0.1',
              servername: 'other.example',
              port: s.address().port,
              ca: readFileSync(path.join(caDir, 'root.crt')),
            },
            () => {
              s.close();
              resolve(false);
            },
          )
          .on('error', () => {
            s.close();
            resolve(true);
          });
      });
    });
    assert.equal(refused, true);
  });

  it('is read the same way by OpenSSL, with the extensions browsers ask for', { skip: !hasOpenssl }, () => {
    const { caDir, leafDir } = fresh();
    ensureCa({ caDir, names: NAMES });
    issueLeaf({ caDir, leafDir, names: NAMES });
    const verify = spawnSync(
      'openssl',
      ['verify', '-CAfile', path.join(caDir, 'root.crt'), path.join(leafDir, 'leaf.crt')],
      { encoding: 'utf8' },
    );
    assert.equal(verify.status, 0, verify.stdout + verify.stderr);
    const text = spawnSync('openssl', ['x509', '-in', path.join(leafDir, 'leaf.crt'), '-noout', '-text'], {
      encoding: 'utf8',
    }).stdout;
    assert.match(text, /TLS Web Server Authentication/);
    assert.match(text, /IP Address:192\.168\.1\.20/);
    assert.match(text, /DNS:host\.local/);
    assert.match(text, /ecdsa-with-SHA256/);
    assert.match(text, /prime256v1/);
    const rootText = spawnSync('openssl', ['x509', '-in', path.join(caDir, 'root.crt'), '-noout', '-text'], {
      encoding: 'utf8',
    }).stdout;
    assert.match(rootText, /CA:TRUE/);
    assert.match(rootText, /Certificate Sign/);
  });

  it('refuses to issue for no names', () => {
    const { caDir, leafDir } = fresh();
    ensureCa({ caDir, names: NAMES });
    assert.throws(() => issueLeaf({ caDir, leafDir, names: [] }), /at least one/);
  });

  it('reads as nothing yet before anything is made', () => {
    const { caDir, leafDir } = fresh();
    assert.deepEqual(info({ caDir, leafDir }), {
      root_not_after: null,
      root_days_left: null,
      root_fingerprint: null,
      root_constrained: false,
      root_covers_leaf: false,
      leaf_not_after: null,
      leaf_days_left: null,
      leaf_names: [],
    });
  });

  it(
    'limits the authority to private addresses and the names it was made for, with the limit marked critical',
    { skip: !hasOpenssl },
    () => {
      const { caDir } = fresh();
      ensureCa({ caDir, names: NAMES });
      const text = spawnSync('openssl', ['x509', '-in', path.join(caDir, 'root.crt'), '-noout', '-text'], {
        encoding: 'utf8',
      }).stdout;
      assert.match(text, /X509v3 Name Constraints: critical/);
      for (const range of [
        '10.0.0.0/255.0.0.0',
        '172.16.0.0/255.240.0.0',
        '192.168.0.0/255.255.0.0',
        '100.64.0.0/255.192.0.0',
        '127.0.0.0/255.0.0.0',
      ]) {
        assert.ok(text.includes('IP:' + range), range);
      }
      assert.ok(text.includes('DNS:host.local'));
      assert.ok(text.includes('DNS:localhost'));
      for (const suffix of ['DNS:local\n', 'DNS:lan', 'DNS:home.arpa', 'DNS:ts.net']) {
        assert.ok(!text.includes(suffix), `${suffix} is not permitted`);
      }
      assert.doesNotMatch(text, /IP:8\./);
      assert.match(text, /email:amanuensis\.invalid/);
      assert.match(text, /URI:amanuensis\.invalid/);
    },
  );

  it('may only sign web server certificates, and nothing below it', { skip: !hasOpenssl }, () => {
    const { caDir } = fresh();
    ensureCa({ caDir, names: NAMES });
    const text = spawnSync('openssl', ['x509', '-in', path.join(caDir, 'root.crt'), '-noout', '-text'], {
      encoding: 'utf8',
    }).stdout;
    assert.match(text, /Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
    assert.match(text, /Extended Key Usage:\s+TLS Web Server Authentication\s*\n/);
    assert.doesNotMatch(text, /Code Signing|E-mail Protection|Client Authentication|Any Extended/);
  });

  describe('as OpenSSL applies the limits to certificates the root signs', { skip: !hasOpenssl }, () => {
    /** Signs a certificate for the given subject alternative name with the root key, the way a stolen key would. */
    const signed = ({ caDir, san, ca = false, issuerDir }) => {
      const work = mkdtempSync(path.join(tmpdir(), 'aman-pki-sign-'));
      const key = path.join(work, 'k.pem');
      const csr = path.join(work, 'r.csr');
      const crt = path.join(work, 'c.crt');
      const ext = path.join(work, 'e.cnf');
      const run = args => {
        const out = spawnSync('openssl', args, { encoding: 'utf8' });
        assert.equal(out.status, 0, out.stderr);
      };
      run([
        'req',
        '-new',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        key,
        '-out',
        csr,
        '-subj',
        '/CN=x',
      ]);
      writeFileSync(
        ext,
        ca
          ? 'basicConstraints=critical,CA:TRUE\nkeyUsage=keyCertSign\n'
          : `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`,
      );
      run([
        'x509',
        '-req',
        '-in',
        csr,
        '-CA',
        path.join(issuerDir ?? caDir, 'root.crt'),
        '-CAkey',
        path.join(caDir, 'root.key'),
        '-CAcreateserial',
        '-days',
        '30',
        '-extfile',
        ext,
        '-out',
        crt,
      ]);
      return { crt, key, work };
    };
    const accepted = ({ caDir, leaf, untrusted }) =>
      spawnSync(
        'openssl',
        ['verify', '-CAfile', path.join(caDir, 'root.crt'), ...(untrusted ? ['-untrusted', untrusted] : []), leaf],
        { encoding: 'utf8' },
      ).status === 0;

    it("accepts this computer's names and private addresses, and nothing else", () => {
      const { caDir } = fresh();
      ensureCa({ caDir, names: NAMES });
      for (const san of ['DNS:host.local', 'DNS:localhost', 'IP:192.168.1.77', 'IP:10.1.2.3']) {
        const { crt } = signed({ caDir, san });
        assert.ok(accepted({ caDir, leaf: crt }), san);
      }
      for (const san of [
        'DNS:other.local',
        'DNS:files.example.internal',
        'DNS:host.ts.net',
        'DNS:example.com',
        'IP:8.8.8.8',
        'email:someone@host.local',
        'URI:https://host.local/',
      ]) {
        const { crt } = signed({ caDir, san });
        assert.ok(!accepted({ caDir, leaf: crt }), san);
      }
    });

    it('refuses a certificate authority signed below it', () => {
      const { caDir } = fresh();
      ensureCa({ caDir, names: NAMES });
      const below = signed({ caDir, ca: true });
      assert.ok(accepted({ caDir, leaf: below.crt }), 'the authority itself is signed by the root');
      const work = mkdtempSync(path.join(tmpdir(), 'aman-pki-below-'));
      const sub = spawnSync(
        'openssl',
        [
          'req',
          '-new',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:prime256v1',
          '-nodes',
          '-keyout',
          path.join(work, 'k.pem'),
          '-out',
          path.join(work, 'r.csr'),
          '-subj',
          '/CN=leaf',
        ],
        { encoding: 'utf8' },
      );
      assert.equal(sub.status, 0, sub.stderr);
      writeFileSync(path.join(work, 'e.cnf'), 'subjectAltName=DNS:host.local\nextendedKeyUsage=serverAuth\n');
      const leaf = path.join(work, 'leaf.crt');
      const sign = spawnSync(
        'openssl',
        [
          'x509',
          '-req',
          '-in',
          path.join(work, 'r.csr'),
          '-CA',
          below.crt,
          '-CAkey',
          below.key,
          '-CAcreateserial',
          '-days',
          '30',
          '-extfile',
          path.join(work, 'e.cnf'),
          '-out',
          leaf,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(sign.status, 0, sign.stderr);
      assert.ok(
        !accepted({ caDir, leaf, untrusted: below.crt }),
        'a leaf under an authority the root signed is refused',
      );
    });
  });

  it('will not issue for a public address or a name it was not made for', () => {
    const { caDir, leafDir } = fresh();
    ensureCa({ caDir, names: NAMES });
    for (const name of [
      '8.8.8.8',
      '172.32.0.1',
      '100.128.0.1',
      'example.com',
      'host.local.example.com',
      'evil-local',
      'other.local',
      'a.b.ts.net',
      'x.home.arpa',
    ]) {
      assert.throws(() => issueLeaf({ caDir, leafDir, names: ['192.168.1.20', name] }), /may not vouch for/, name);
    }
    assert.equal(issueLeaf({ caDir, leafDir, names: ['172.31.255.254', '100.127.0.1', 'host.local'] }).issued, true);
  });

  it('is made again, and says so, when a name asked for is not covered, and then keeps that name', () => {
    const { caDir, leafDir } = fresh();
    assert.equal(ensureCa({ caDir, names: ['host.local', '192.168.1.20'] }).rotated, false);
    const first = readFileSync(path.join(caDir, 'root.crt'), 'utf8');
    assert.equal(ensureCa({ caDir, names: ['host.local'] }).created, false);
    const second = ensureCa({ caDir, names: ['host', 'host.local'] });
    assert.equal(second.created, true);
    assert.equal(second.rotated, true);
    assert.notEqual(readFileSync(path.join(caDir, 'root.crt'), 'utf8'), first);
    assert.equal(issueLeaf({ caDir, leafDir, names: ['host', 'host.local', '192.168.1.20'] }).issued, true);
    assert.equal(ensureCa({ caDir, names: ['host'] }).created, false);
    assert.equal(ensureCa({ caDir, names: ['files', 'host'] }).rotated, true);
    assert.equal(ensureCa({ caDir, names: ['host'] }).created, false, 'a name added once stays permitted');
  });

  it('replaces an authority made under older limits, once', () => {
    const { caDir } = fresh();
    ensureCa({ caDir, names: NAMES });
    writeFileSync(path.join(caDir, 'root.names'), '["host.local"]\n');
    const result = ensureCa({ caDir, names: NAMES });
    assert.equal(result.rotated, true);
    assert.equal(ensureCa({ caDir, names: NAMES }).created, false);
  });

  it('replaces an authority from before it had limits, once', () => {
    const { caDir } = fresh();
    ensureCa({ caDir, names: NAMES });
    rmSync(path.join(caDir, 'root.names'));
    const result = ensureCa({ caDir, names: NAMES });
    assert.equal(result.rotated, true);
    assert.equal(ensureCa({ caDir, names: NAMES }).created, false);
  });

  it('writes the fingerprint of the root where the installer can read it, in the form devices show', () => {
    const { caDir } = fresh();
    const result = ensureCa({ caDir, names: NAMES });
    assert.match(result.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(readFileSync(path.join(caDir, 'root.fingerprint'), 'utf8').trim(), result.fingerprint);
    assert.equal(info({ caDir, leafDir: path.join(caDir, 'none') }).root_fingerprint, result.fingerprint);
    if (hasOpenssl) {
      const shown = spawnSync(
        'openssl',
        ['x509', '-in', path.join(caDir, 'root.crt'), '-noout', '-fingerprint', '-sha256'],
        { encoding: 'utf8' },
      ).stdout;
      assert.equal(shown.trim().split('=')[1], result.fingerprint);
    }
  });

  it('issues again when the certificate and the key next to it are not a pair, and notes when it ends', () => {
    const { caDir, leafDir } = fresh();
    ensureCa({ caDir, names: NAMES });
    issueLeaf({ caDir, leafDir, names: NAMES });
    const ends = Number(readFileSync(path.join(leafDir, 'leaf.notafter'), 'utf8'));
    assert.ok(ends * 1000 - Date.now() > 396 * DAY);
    const other = path.join(dir, 'other');
    issueLeaf({ caDir, leafDir: other, names: NAMES });
    writeFileSync(path.join(leafDir, 'leaf.key'), readFileSync(path.join(other, 'leaf.key')));
    assert.equal(leafIsCurrent({ caDir, leafDir, names: NAMES }), false);
    assert.equal(issueLeaf({ caDir, leafDir, names: NAMES }).issued, true);
    assert.equal(leafIsCurrent({ caDir, leafDir, names: NAMES }), true);
  });
});
