// The local certificate authority of this computer and the one certificate its web front end serves, with no
// dependencies beyond Node.js. One long-lived root signs a leaf that lists every address the instance opens at, so a
// browser that sends no server name (anything opened by IP address) still gets a certificate that matches.
//
//   node pki.mjs ensure-ca <ca-dir>
//   node pki.mjs issue <ca-dir> <leaf-dir> <names...>      issues when missing, expiring or for other names
//   node pki.mjs info <ca-dir> <leaf-dir>                   one line of JSON: when each expires and for which names

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT_YEARS = 10;
export const LEAF_DAYS = 397;
/** An authority this close to its end is made again. */
export const ROOT_REPLACE_DAYS = 30;
/** A leaf this close to its end is issued again. */
export const RENEW_BEFORE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let rest = n; rest > 0; rest >>>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const seq = (...parts) => der(0x30, ...parts);
const set = (...parts) => der(0x31, ...parts);
const octets = buffer => der(0x04, buffer);
const bits = (buffer, unused = 0) => der(0x03, Buffer.from([unused]), buffer);
const bool = value => der(0x01, Buffer.from([value ? 0xff : 0]));
const utf8 = text => der(0x0c, Buffer.from(text, 'utf8'));
const explicit = (n, ...parts) => der(0xa0 + n, ...parts);

function integer(buffer) {
  let bytes = Buffer.from(buffer);
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) bytes = bytes.subarray(1);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return der(0x02, bytes);
}

function oid(text) {
  const parts = text.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let rest = part >>> 7; rest > 0; rest >>>= 7) chunk.unshift((rest & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function time(date) {
  const pad = n => String(n).padStart(2, '0');
  const text = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return date.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(text.slice(2))) : der(0x18, Buffer.from(text));
}

const name = commonName =>
  seq(set(seq(oid('2.5.4.10'), utf8('Amanuensis'))), set(seq(oid('2.5.4.3'), utf8(commonName))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const extension = (id, value, critical = false) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

function generalName(text) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(text)) return der(0x87, Buffer.from(text.split('.').map(Number)));
  return der(0x82, Buffer.from(text, 'ascii'));
}

function keyId(publicKey) {
  return crypto
    .createHash('sha1')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest();
}

function certificate({ subject, issuer, publicKey, signingKey, notBefore, notAfter, extensions }) {
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(crypto.randomBytes(16)),
    ECDSA_SHA256,
    name(issuer),
    seq(time(notBefore), time(notAfter)),
    name(subject),
    Buffer.from(publicKey.export({ type: 'spki', format: 'der' })),
    explicit(3, seq(...extensions)),
  );
  const signature = crypto.sign('sha256', tbs, { key: signingKey, dsaEncoding: 'der' });
  const body = seq(tbs, ECDSA_SHA256, bits(signature));
  const lines = body.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function makeKey() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function writeFile({ file, text, mode }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(temporary, text, { mode });
  fs.renameSync(temporary, file);
}

/** Makes the root certificate and its key unless they exist. The key is readable by its owner only. */
export function ensureCa({ caDir, now = new Date() }) {
  const certFile = path.join(caDir, 'root.crt');
  const keyFile = path.join(caDir, 'root.key');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const current = new crypto.X509Certificate(fs.readFileSync(certFile)).validToDate;
    // An authority about to end is replaced; devices then trust the new one the way they did the first.
    if (current.getTime() - now.getTime() > ROOT_REPLACE_DAYS * DAY_MS) return { created: false, notAfter: current };
  }
  const { publicKey, privateKey } = makeKey();
  const notBefore = new Date(now.getTime() - DAY_MS);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + ROOT_YEARS);
  const pem = certificate({
    subject: 'Amanuensis home server',
    issuer: 'Amanuensis home server',
    publicKey,
    signingKey: privateKey,
    notBefore,
    notAfter,
    extensions: [
      extension('2.5.29.19', seq(bool(true)), true),
      extension('2.5.29.15', bits(Buffer.from([0x06]), 1), true),
      extension('2.5.29.14', octets(keyId(publicKey))),
    ],
  });
  writeFile({ file: keyFile, text: privateKey.export({ type: 'pkcs8', format: 'pem' }), mode: 0o600 });
  writeFile({ file: certFile, text: pem, mode: 0o644 });
  return { created: true, notAfter };
}

function namesOf(cert) {
  return (cert.subjectAltName ?? '')
    .split(', ')
    .map(entry => entry.replace(/^(DNS|IP Address):/, ''))
    .filter(entry => entry !== '')
    .sort();
}

/** True when the leaf there is still good for these names, under this root, for long enough. */
export function leafIsCurrent({ caDir, leafDir, names, now = new Date() }) {
  const leafFile = path.join(leafDir, 'leaf.crt');
  if (!fs.existsSync(leafFile) || !fs.existsSync(path.join(leafDir, 'leaf.key'))) return false;
  const leaf = new crypto.X509Certificate(fs.readFileSync(leafFile));
  const root = new crypto.X509Certificate(fs.readFileSync(path.join(caDir, 'root.crt')));
  return (
    leaf.verify(root.publicKey) &&
    leaf.validToDate.getTime() - now.getTime() > RENEW_BEFORE_DAYS * DAY_MS &&
    JSON.stringify(namesOf(leaf)) === JSON.stringify([...names].sort())
  );
}

/** Issues the leaf for the names unless the current one already serves them; the key never leaves leafDir. */
export function issueLeaf({ caDir, leafDir, names, now = new Date() }) {
  if (names.length === 0) throw new Error('A certificate needs at least one name or address');
  if (leafIsCurrent({ caDir, leafDir, names, now })) return { issued: false };
  const rootKey = crypto.createPrivateKey(fs.readFileSync(path.join(caDir, 'root.key')));
  const root = new crypto.X509Certificate(fs.readFileSync(path.join(caDir, 'root.crt')));
  const { publicKey, privateKey } = makeKey();
  const notAfter = new Date(now.getTime() + LEAF_DAYS * DAY_MS);
  const pem = certificate({
    subject: names[0],
    issuer: 'Amanuensis home server',
    publicKey,
    signingKey: rootKey,
    notBefore: new Date(now.getTime() - 60 * 60 * 1000),
    notAfter,
    extensions: [
      extension('2.5.29.19', seq(), true),
      extension('2.5.29.15', bits(Buffer.from([0x80]), 7), true),
      extension('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.1'))),
      extension('2.5.29.17', seq(...names.map(generalName))),
      extension('2.5.29.14', octets(keyId(publicKey))),
      extension('2.5.29.35', seq(der(0x80, keyId(root.publicKey)))),
    ],
  });
  writeFile({
    file: path.join(leafDir, 'leaf.key'),
    text: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    mode: 0o600,
  });
  writeFile({ file: path.join(leafDir, 'leaf.crt'), text: pem, mode: 0o644 });
  return { issued: true, notAfter };
}

/** When the root and the leaf end and which names the leaf serves; missing files read as null. */
export function info({ caDir, leafDir, now = new Date() }) {
  const read = file => (fs.existsSync(file) ? new crypto.X509Certificate(fs.readFileSync(file)) : undefined);
  const root = read(path.join(caDir, 'root.crt'));
  const leaf = read(path.join(leafDir, 'leaf.crt'));
  const daysLeft = cert =>
    cert === undefined ? null : Math.floor((cert.validToDate.getTime() - now.getTime()) / DAY_MS);
  return {
    root_not_after: root?.validToDate.toISOString() ?? null,
    root_days_left: daysLeft(root),
    leaf_not_after: leaf?.validToDate.toISOString() ?? null,
    leaf_days_left: daysLeft(leaf),
    leaf_names: leaf === undefined ? [] : namesOf(leaf),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, caDir, third, ...rest] = process.argv.slice(2);
  if (command === 'ensure-ca' && caDir !== undefined) {
    const result = ensureCa({ caDir });
    process.stdout.write(`${JSON.stringify({ created: result.created, not_after: result.notAfter.toISOString() })}\n`);
  } else if (command === 'issue' && caDir !== undefined && third !== undefined) {
    const result = issueLeaf({ caDir, leafDir: third, names: rest });
    process.stdout.write(`${JSON.stringify({ issued: result.issued })}\n`);
  } else if (command === 'info' && caDir !== undefined && third !== undefined) {
    process.stdout.write(`${JSON.stringify(info({ caDir, leafDir: third }))}\n`);
  } else {
    process.stderr.write(
      'usage: pki.mjs ensure-ca <ca-dir> | issue <ca-dir> <leaf-dir> <names...> | info <ca-dir> <leaf-dir>\n',
    );
    process.exit(2);
  }
}
