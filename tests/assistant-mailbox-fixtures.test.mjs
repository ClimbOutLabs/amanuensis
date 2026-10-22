import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { buildMessages } from '../demo/fixtures/mailbox/generate-fixtures.mjs';
import { loadDemoSet } from '../demo/scripts/test-mailbox-env.mjs';
import { parseDemoDay } from '../packages/trueforge/src/cli/demoSeed/storyDays.mjs';

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo', 'fixtures', 'mailbox');

const EXPECTED_DEMO_SET = [
  '01-flight-confirmation.eml',
  '02-gp-appointment-confirmation.eml',
  '03-portuguese-electricity-bill.eml',
  '04-portuguese-landlord-repair.eml',
  '06-package-delivery.eml',
  '07-dinner-plans.eml',
  '08-camera-order-ready.eml',
  '09-phishing-warning.eml',
  '10a-trip-plan.eml',
  '10b-trip-plan-reply.eml',
  '10c-trip-plan-change.eml',
  '11-calendar-invite.eml',
  '12-scanned-note.eml',
  '21-portuguese-class-homework.eml',
  '22-portuguese-bakery-order.eml',
  '23-spanish-lunch-invite.eml',
  '24-english-photo-walk-itinerary.eml',
  '25-gp-consulta-confirmacao.eml',
];

// The committed .eml files are the snapshot made for this day; other days are checked in memory.
const SNAPSHOT_DAY = parseDemoDay('2026-10-19');
const messages = loadDemoSet({ fixtureDir, today: SNAPSHOT_DAY });

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
  assert.ok(left.includes('05-school-newsletter.eml'));
  assert.ok(left.includes('17-spanish-internet-bill.eml'));
  assert.ok(left.includes('13-arabic-hotel-booking.eml'));
  assert.equal(allFixtures.length, EXPECTED_DEMO_SET.length + left.length);
});

test('demo languages are English, Portuguese and Spanish only', () => {
  const counts = {};
  for (const { language } of messages) {
    counts[language] = (counts[language] ?? 0) + 1;
  }
  assert.deepEqual(counts, { English: 12, Portuguese: 5, Spanish: 1 });
});

test('every demo message has a unique Message-ID and is addressed to Maya', () => {
  const ids = messages.map(message => message.messageId);
  assert.equal(new Set(ids).size, ids.length);
  for (const message of messages) {
    assert.match(message.messageId, /^<[^<>\s]+>$/, message.file);
    const text = message.raw.toString('latin1');
    assert.ok(!/alex|rivera/i.test(text), `${message.file} has no old persona name`);
    assert.ok(
      !/barcelona|gràcia|gr=C3=A0cia|poblenou|\$\d/i.test(text),
      `${message.file} is not set in Barcelona or dollars`,
    );
    if (message.file !== '10b-trip-plan-reply.eml' && message.file !== '12-scanned-note.eml') {
      assert.match(text, /^To: Maya Hollis <maya\.hollis@example\.com>/m, message.file);
    }
  }
});

test('demo dates fall in the 7 days before the snapshot day, and threads stay in order', () => {
  const start = Date.parse('2026-10-12T00:00:00+01:00');
  const end = Date.parse('2026-10-19T00:00:00+01:00');
  const times = new Map();
  for (const message of messages) {
    const time = Date.parse(message.date);
    assert.ok(time >= start && time < end, `${message.file}: ${message.date}`);
    times.set(message.file, time);
  }
  assert.ok(times.get('10a-trip-plan.eml') < times.get('10b-trip-plan-reply.eml'));
  assert.ok(times.get('10b-trip-plan-reply.eml') < times.get('10c-trip-plan-change.eml'));
  const days = new Set(messages.map(message => new Date(Date.parse(message.date) + 3600e3).toISOString().slice(0, 10)));
  assert.equal(days.size, 7);
});

test('the committed .eml files are the snapshot made for 2026-10-19', () => {
  const generated = buildMessages({ today: SNAPSHOT_DAY });
  for (const name of readdirSync(fixtureDir).filter(file => file.endsWith('.eml'))) {
    assert.ok(readFileSync(path.join(fixtureDir, name)).equals(Buffer.from(generated[name], 'utf8')), name);
  }
});

const DAYS = [
  { label: 'a Monday', day: { year: 2026, month: 10, day: 19 } },
  { label: 'a Thursday', day: { year: 2026, month: 10, day: 22 } },
  { label: 'a Sunday', day: { year: 2026, month: 10, day: 25 } },
];
const EN_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EN_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EN_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const PT_WEEKDAYS = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
];
const PT_MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];
const ES_WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const ES_MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

function dateMs(day) {
  return Date.UTC(day.year, day.month - 1, day.day);
}

function plusDays(day, offset) {
  const date = new Date(dateMs(day) + offset * 86400e3);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayOf(day) {
  return new Date(dateMs(day)).getUTCDay();
}

const ENGLISH_WEEKDAY = '(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)';
const PORTUGUESE_WEEKDAY = '(domingo|segunda-feira|terça-feira|quarta-feira|quinta-feira|sexta-feira|sábado)';
const SPANISH_WEEKDAY = '(domingo|lunes|martes|miércoles|jueves|viernes|sábado)';

/** Each weekday written next to a day number in the text, with the weekday index it must match. */
function weekdayMentions(text) {
  const mentions = [];
  const add = ({ weekday, day, month }) => mentions.push({ weekday, day, month });
  for (const [, weekday, month, day] of text.matchAll(
    new RegExp(`${ENGLISH_WEEKDAY},? (October|November) (\\d{1,2})\\b`, 'g'),
  )) {
    add({ weekday: EN_WEEKDAYS.indexOf(weekday), day: Number(day), month: EN_MONTHS.indexOf(month) + 1 });
  }
  for (const [, weekday, day, month] of text.matchAll(
    new RegExp(`${ENGLISH_WEEKDAY},? (\\d{1,2}) (October|November)\\b`, 'g'),
  )) {
    add({ weekday: EN_WEEKDAYS.indexOf(weekday), day: Number(day), month: EN_MONTHS.indexOf(month) + 1 });
  }
  for (const [, weekday, day] of text.matchAll(
    new RegExp(`${ENGLISH_WEEKDAY} the (\\d{1,2})(?:st|nd|rd|th)\\b`, 'g'),
  )) {
    add({ weekday: EN_WEEKDAYS.indexOf(weekday), day: Number(day), month: null });
  }
  for (const [, short, month, day] of text.matchAll(/\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*,? (Oct|Nov) (\d{1,2})\b/g)) {
    add({ weekday: EN_SHORT.indexOf(short), day: Number(day), month: month === 'Oct' ? 10 : 11 });
  }
  for (const [, weekday, day, month] of text.matchAll(
    new RegExp(`${PORTUGUESE_WEEKDAY},? (\\d{1,2}) de (outubro|novembro)\\b`, 'g'),
  )) {
    add({ weekday: PT_WEEKDAYS.indexOf(weekday), day: Number(day), month: PT_MONTHS.indexOf(month) + 1 });
  }
  for (const [, weekday, day, month] of text.matchAll(
    new RegExp(`${SPANISH_WEEKDAY} (\\d{1,2}) de (octubre|noviembre)\\b`, 'g'),
  )) {
    add({ weekday: ES_WEEKDAYS.indexOf(weekday), day: Number(day), month: ES_MONTHS.indexOf(month) + 1 });
  }
  return mentions;
}

/** The message as text, with quoted-printable lines joined and =XX bytes read back as UTF-8. */
function decodedText(message) {
  const joined = message.raw.toString('latin1').replace(/=\r?\n/g, '');
  const bytes = joined.replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

function textOf(message) {
  return `${message.subject}\n${decodedText(message)}`;
}

function headerDayMs(message) {
  // The header's own calendar day, before its time and zone, is the day the sender wrote.
  return Date.parse(`${message.date.slice(0, 16)} GMT`);
}

for (const { label, day } of DAYS) {
  test(`mail made for ${label} has no future dates, matching weekday names, and upcoming items ahead`, () => {
    const made = loadDemoSet({ today: day });
    const byFile = Object.fromEntries(made.map(message => [message.file, message]));
    for (const message of made) {
      assert.ok(headerDayMs(message) < dateMs(day), `${message.file} is not dated after today`);
      assert.equal(
        new Date(headerDayMs(message)).getUTCDay(),
        EN_SHORT.indexOf(message.date.slice(0, 3)),
        message.file,
      );
      for (const mention of weekdayMentions(textOf(message))) {
        const mentioned = { year: day.year, month: mention.month ?? day.month, day: mention.day };
        assert.equal(weekdayOf(mentioned), mention.weekday, `${message.file}: day ${mention.day} is not that weekday`);
      }
    }
    const gp = plusDays(day, 3);
    assert.ok(
      weekdayMentions(textOf(byFile['02-gp-appointment-confirmation.eml'])).some(
        mention => mention.day === gp.day && mention.month === gp.month && mention.weekday === weekdayOf(gp),
      ),
      'the GP appointment is three days ahead',
    );
    const dueDay = plusDays(day, 11);
    const due = /Pagar até: (\d{1,2}) de (\w+) de (\d{4})/.exec(
      decodedText(byFile['03-portuguese-electricity-bill.eml']),
    );
    assert.deepEqual(
      { day: Number(due[1]), month: PT_MONTHS.indexOf(due[2]) + 1 },
      { day: dueDay.day, month: dueDay.month },
    );
    for (const offset of [2, 4]) {
      const option = plusDays(day, offset);
      assert.ok(
        weekdayMentions(textOf(byFile['07-dinner-plans.eml'])).some(
          mention => mention.day === option.day && mention.weekday === weekdayOf(option),
        ),
        `dinner option ${String(offset)} days ahead`,
      );
    }
  });
}

// Decodes the quoted-printable body of a message written by the generator.
function decodeQuotedPrintable(text) {
  const bytes = text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

test('the bill is named for the month it bills, and the closing names the homework deadline weekday', () => {
  const november = buildMessages({ today: parseDemoDay('2026-11-10') });
  assert.match(november['03-portuguese-electricity-bill.eml'], /filename="fatura-outubro\.pdf"/);
  assert.doesNotMatch(november['03-portuguese-electricity-bill.eml'], /fatura-setembro/);

  const december = buildMessages({ today: parseDemoDay('2026-12-31') });
  assert.match(december['03-portuguese-electricity-bill.eml'], /filename="fatura-novembro\.pdf"/);

  const tuesday = buildMessages({ today: parseDemoDay('2026-10-18') });
  const homework = decodeQuotedPrintable(tuesday['21-portuguese-class-homework.eml']);
  assert.match(homework, /até terça-feira, 20 de outubro/);
  assert.match(homework, /Até terça-feira!/);
  assert.doesNotMatch(homework, /Até quarta/);

  const newYear = decodeQuotedPrintable(
    buildMessages({ today: parseDemoDay('2026-12-31') })['21-portuguese-class-homework.eml'],
  );
  assert.match(newYear, /Até sábado!/);
});

test('mail made for two different days has different Message-IDs', () => {
  const monday = loadDemoSet({ today: DAYS[0].day }).map(message => message.messageId);
  const thursday = loadDemoSet({ today: DAYS[1].day }).map(message => message.messageId);
  assert.equal(new Set([...monday, ...thursday]).size, monday.length + thursday.length);
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

function assertValidDocx({ file, filename, headings, rows, text }) {
  const entries = readZip(readAttachment({ file, filename }));
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
  assert.equal(document.match(/w:pStyle w:val="Heading1"/g).length, headings);
  assert.equal(document.match(/<w:tr>/g).length, rows);
  assert.match(document, text);
}

test('the Portuguese repair notice .docx is a valid package with headings and a table', () => {
  assertValidDocx({
    file: '04-portuguese-landlord-repair.eml',
    filename: 'aviso-de-reparacao.docx',
    headings: 3,
    rows: 5,
    text: /Reparação da torneira da cozinha/,
  });
});

test('the photo walk itinerary .docx is a valid package with headings and a table', () => {
  assertValidDocx({
    file: '24-english-photo-walk-itinerary.eml',
    filename: 'Old Lisbon photo walks - draft itinerary.docx',
    headings: 3,
    rows: 4,
    text: /Alfama at sunrise/,
  });
});

test('the PDFs in 01 and 03 are still attached, and the Portuguese one keeps its accents', () => {
  for (const [file, filename] of [
    ['01-flight-confirmation.eml', 'itinerary.pdf'],
    ['03-portuguese-electricity-bill.eml', 'fatura-setembro.pdf'],
  ]) {
    assert.equal(readAttachment({ file, filename }).subarray(0, 5).toString('ascii'), '%PDF-');
  }
  const bill = readAttachment({ file: '03-portuguese-electricity-bill.eml', filename: 'fatura-setembro.pdf' });
  assert.ok(bill.includes('/WinAnsiEncoding'));
  assert.ok(bill.toString('latin1').includes('Período de faturação'));
});
