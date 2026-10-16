import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { loadDemoSet } from '../scripts/import-demo-mailbox.mjs';

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test-fixtures',
  'assistant-mailbox',
);

const EXPECTED_DEMO_SET = [
  '01-flight-confirmation.eml',
  '02-dentist-reminder.eml',
  '03-utility-bill.eml',
  '04-landlord-repair.eml',
  '05-school-newsletter.eml',
  '06-package-delivery.eml',
  '07-dinner-plans.eml',
  '08-receipt.eml',
  '09-phishing-warning.eml',
  '10a-trip-plan.eml',
  '10b-trip-plan-reply.eml',
  '10c-trip-plan-change.eml',
  '11-calendar-invite.eml',
  '12-scanned-note.eml',
  '17-spanish-internet-bill.eml',
  '21-portuguese-lisbon-weekend.eml',
  '22-portuguese-bakery-order.eml',
  '23-spanish-neighbours-meeting.eml',
  '24-english-lisbon-itinerary-draft.eml',
];

const messages = loadDemoSet({ fixtureDir });

test('the demo set is exactly the chosen fixtures, and other-language fixtures stay out', () => {
  assert.deepEqual(
    messages.map(message => message.file),
    EXPECTED_DEMO_SET,
  );
  const allFixtures = readdirSync(fixtureDir).filter(name => name.endsWith('.eml'));
  for (const name of EXPECTED_DEMO_SET) {
    assert.ok(allFixtures.includes(name), `${name} exists`);
  }
  const left = allFixtures.filter(name => !EXPECTED_DEMO_SET.includes(name));
  assert.ok(left.includes('20-persian-english-family.eml'));
  assert.ok(left.includes('13-arabic-hotel-booking.eml'));
  assert.equal(allFixtures.length, EXPECTED_DEMO_SET.length + left.length);
});

test('demo languages are English, Portuguese and Spanish only', () => {
  const counts = {};
  for (const { language } of messages) {
    counts[language] = (counts[language] ?? 0) + 1;
  }
  assert.deepEqual(counts, { English: 15, Spanish: 2, Portuguese: 2 });
});

test('every demo message has a unique Message-ID and is addressed to Maya', () => {
  const ids = messages.map(message => message.messageId);
  assert.equal(new Set(ids).size, ids.length);
  for (const message of messages) {
    assert.match(message.messageId, /^<[^<>\s]+>$/, message.file);
    const text = message.raw.toString('latin1');
    assert.ok(!/alex|rivera/i.test(text), `${message.file} has no old persona name`);
    if (message.file !== '10b-trip-plan-reply.eml' && message.file !== '12-scanned-note.eml') {
      assert.match(text, /^To: Maya Hollis <maya\.hollis@example\.com>/m, message.file);
    }
  }
});

test('demo dates fall in the 7 days before Oct 19, 2026 and threads stay in order', () => {
  const start = Date.parse('2026-10-12T00:00:00+02:00');
  const end = Date.parse('2026-10-19T00:00:00+02:00');
  const times = new Map();
  for (const message of messages) {
    const time = Date.parse(message.date);
    assert.ok(time >= start && time < end, `${message.file}: ${message.date}`);
    times.set(message.file, time);
  }
  assert.ok(times.get('10a-trip-plan.eml') < times.get('10b-trip-plan-reply.eml'));
  assert.ok(times.get('10b-trip-plan-reply.eml') < times.get('10c-trip-plan-change.eml'));
  const days = new Set(
    messages.map(message => new Date(Date.parse(message.date) + 2 * 3600e3).toISOString().slice(0, 10)),
  );
  assert.equal(days.size, 7);
});

function readAttachment({ file, filename }) {
  const text = readFileSync(path.join(fixtureDir, file), 'latin1');
  const marker = `filename="${filename}"`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `${filename} is attached`);
  const body = text.slice(text.indexOf('\r\n\r\n', start) + 4).split(/\r?\n--/)[0];
  return Buffer.from(body.replace(/\s+/g, ''), 'base64');
}

function readZip(buffer) {
  const endAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endAt >= 0, 'zip end record');
  const count = buffer.readUInt16LE(endAt + 10);
  let cursor = buffer.readUInt32LE(endAt + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const size = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localAt = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const stored = buffer.subarray(dataAt, dataAt + size);
    const data = method === 8 ? inflateRawSync(stored) : stored;
    assert.equal(crc32(data), crc, `${name} checksum`);
    entries.set(name, data.toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertWellFormedXml({ xml, name }) {
  assert.ok(xml.startsWith('<?xml'), `${name} has an XML declaration`);
  const stack = [];
  for (const [tag] of xml.replace(/<\?[\s\S]*?\?>/g, '').matchAll(/<[^>]+>/g)) {
    if (tag.endsWith('/>')) {
      continue;
    }
    const tagName = /^<\/?([^\s/>]+)/.exec(tag)[1];
    if (tag.startsWith('</')) {
      assert.equal(stack.pop(), tagName, `${name}: closing ${tagName}`);
    } else {
      stack.push(tagName);
    }
  }
  assert.deepEqual(stack, [], `${name}: all tags closed`);
}

test('the Lisbon itinerary .docx is a valid package with headings and a table', () => {
  const docx = readAttachment({
    file: '24-english-lisbon-itinerary-draft.eml',
    filename: 'Lisbon weekend itinerary draft.docx',
  });
  const entries = readZip(docx);
  assert.deepEqual([...entries.keys()].sort(), [
    '[Content_Types].xml',
    '_rels/.rels',
    'docProps/core.xml',
    'word/document.xml',
    'word/styles.xml',
  ]);
  for (const [name, xml] of entries) {
    assertWellFormedXml({ xml, name });
  }
  assert.match(entries.get('[Content_Types].xml'), /wordprocessingml\.document\.main\+xml/);
  assert.match(entries.get('_rels/.rels'), /Target="word\/document\.xml"/);
  const document = entries.get('word/document.xml');
  assert.equal(document.match(/w:pStyle w:val="Heading1"/g).length, 3);
  assert.equal(document.match(/<w:tr>/g).length, 5);
  assert.match(document, /Lisbon weekend itinerary draft/);
});

test('the English PDFs 01 and 03 are still attached', () => {
  for (const [file, filename] of [
    ['01-flight-confirmation.eml', 'itinerary.pdf'],
    ['03-utility-bill.eml', 'bill.pdf'],
  ]) {
    assert.equal(readAttachment({ file, filename }).subarray(0, 5).toString('ascii'), '%PDF-');
  }
});
