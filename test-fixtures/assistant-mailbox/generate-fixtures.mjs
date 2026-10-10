#!/usr/bin/env node
// Generate the synthetic test mailbox fixtures.
//
// Produces the .eml files in test-fixtures/assistant-mailbox/ with all
// attachments embedded. Everything is fictional: invented names, companies,
// addresses, phone numbers, booking codes and amounts, and only reserved
// example domains (example.com, example.org, example.net).
//
// The output is deterministic: running this script twice produces
// byte-identical files. No standalone binaries are written; attachments are
// embedded in the .eml files as base64. The PNG note is rendered with an
// embedded 5x7 bitmap font and a hand-rolled PNG encoder, so the script
// needs only Node.js and no extra dependencies.
//
// Usage:
//   pnpm generate-test-mailbox

import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

const BOUNDARY = '----=_fixture-boundary-7d3a9f2c';

function pdfEscape(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function makeTextPdf(title, lines) {
  // Build a minimal one-page text PDF. All input must be ASCII.
  const contentParts = [];
  let y = 740;
  for (const line of lines) {
    contentParts.push(`BT /F1 11 Tf 72 ${y} Td (${pdfEscape(line)}) Tj ET`);
    y -= 15;
  }
  const content = Buffer.from(contentParts.join('\n'), 'ascii');
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      'ascii',
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'ascii'),
      content,
      Buffer.from('\nendstream', 'ascii'),
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii'),
    Buffer.from(`<< /Title (${pdfEscape(title)}) /Producer (fixture-generator) >>`, 'ascii'),
  ];
  const parts = [Buffer.from('%PDF-1.4\n', 'ascii')];
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(parts.reduce((total, part) => total + part.length, 0));
    parts.push(Buffer.from(`${index + 1} 0 obj\n`, 'ascii'), body, Buffer.from('\nendobj\n', 'ascii'));
  });
  const xrefPos = parts.reduce((total, part) => total + part.length, 0);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  parts.push(
    Buffer.from(xref, 'ascii'),
    Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\n`, 'ascii'),
    Buffer.from(`startxref\n${xrefPos}\n%%EOF`, 'ascii'),
  );
  return Buffer.concat(parts);
}

// 5x7 bitmap font, rows top to bottom, '#' is a set pixel. The 'g' and 'y'
// glyphs use an eighth row for their descenders.
const FONT = {
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  ',': ['.....', '.....', '.....', '.....', '..#..', '..#..', '.#...'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '..#..', '..#..'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  ':': ['.....', '..#..', '..#..', '.....', '..#..', '..#..', '.....'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  b: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '####.'],
  c: ['.....', '.....', '.###.', '#...#', '#....', '#...#', '.###.'],
  d: ['....#', '....#', '.####', '#...#', '#...#', '#...#', '.####'],
  e: ['.....', '.....', '.###.', '#...#', '####.', '#....', '.###.'],
  f: ['..##.', '.#..#', '.#...', '####.', '.#...', '.#...', '.#...'],
  g: ['.....', '.....', '.###.', '#...#', '#...#', '.###.', '....#', '.##..'],
  h: ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
  i: ['..#..', '.....', '.##..', '..#..', '..#..', '..#..', '.###.'],
  k: ['#....', '#....', '#..#.', '#.#..', '##...', '#.#..', '#..#.'],
  l: ['.##..', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  m: ['.....', '.....', '#.##.', '##.##', '#.#.#', '#.#.#', '#.#.#'],
  n: ['.....', '.....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  r: ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
  t: ['..#..', '..#..', '#####', '..#..', '..#..', '..#..', '...#.'],
  u: ['.....', '.....', '#...#', '#...#', '#...#', '#...#', '.###.'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  y: ['.....', '.....', '#...#', '#...#', '#...#', '.####', '....#', '.##..'],
};

function crc32(data) {
  if (!crc32.table) {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crc32.table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function makeNotePng(lines) {
  // Render a scanned-note style PNG with typed text. Returns a Buffer with
  // the encoded PNG (8-bit truecolor, no ancillary chunks, deterministic).
  const width = 800;
  const height = 320;
  const scale = 3;
  const pixels = Buffer.alloc(width * height * 3, 255);
  const setPixel = ({ x, y, rgb }) => {
    if (x < 0 || x >= width || y < 0 || y >= height) {
      return;
    }
    const offset = (y * width + x) * 3;
    pixels[offset] = rgb[0];
    pixels[offset + 1] = rgb[1];
    pixels[offset + 2] = rgb[2];
  };
  const outlineRect = ({ x0, y0, x1, y1, rgb }) => {
    for (let x = x0; x <= x1; x++) {
      setPixel({ x, y: y0, rgb });
      setPixel({ x, y: y1, rgb });
    }
    for (let y = y0; y <= y1; y++) {
      setPixel({ x: x0, y, rgb });
      setPixel({ x: x1, y, rgb });
    }
  };
  const drawText = ({ text, x, y, rgb }) => {
    let cursorX = x;
    for (const char of text) {
      const glyph = FONT[char] ?? FONT[' '];
      glyph.forEach((row, rowIndex) => {
        for (let col = 0; col < 5; col++) {
          if (row[col] !== '#') {
            continue;
          }
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              setPixel({ x: cursorX + col * scale + sx, y: y + rowIndex * scale + sy, rgb });
            }
          }
        }
      });
      cursorX += 5 * scale + scale;
    }
  };

  outlineRect({ x0: 8, y0: 8, x1: width - 9, y1: height - 9, rgb: [160, 160, 160] });
  let y = 48;
  for (const line of lines) {
    drawText({ text: line, x: 48, y, rgb: [20, 20, 20] });
    y += 44;
  }
  drawText({ text: '-- scanned note --', x: 48, y: height - 52, rgb: [130, 130, 130] });

  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row++) {
    raw[row * (1 + width * 3)] = 0; // filter type: none
    pixels.copy(raw, row * (1 + width * 3) + 1, row * width * 3, (row + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function crlfJoin(parts) {
  return parts.join('\r\n');
}

function base64Lines(data) {
  // Wrap base64 at 76 columns like Python's base64.encodebytes, which uses
  // LF-only line breaks inside the block.
  return data
    .toString('base64')
    .match(/.{1,76}/g)
    .join('\n');
}

function emlSimple({ from, to, date, subject, msgid, body, extraHeaders = [] }) {
  return crlfJoin([
    `From: ${from}`,
    `To: ${to}`,
    `Date: ${date}`,
    `Subject: ${subject}`,
    `Message-ID: ${msgid}`,
    ...extraHeaders,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    body,
    '',
  ]);
}

function emlWithAttachments({ from, to, date, subject, msgid, body, attachments, extraHeaders = [] }) {
  const head = [
    `From: ${from}`,
    `To: ${to}`,
    `Date: ${date}`,
    `Subject: ${subject}`,
    `Message-ID: ${msgid}`,
    ...extraHeaders,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
    '',
    `--${BOUNDARY}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    body,
  ];
  for (const { filename, mime, data } of attachments) {
    head.push(
      `--${BOUNDARY}`,
      `Content-Type: ${mime}; name="${filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${filename}"`,
      '',
      base64Lines(data),
    );
  }
  head.push(`--${BOUNDARY}--`, '');
  return crlfJoin(head);
}

const OWNER = 'Alex Rivera <alex.rivera@example.com>';

function buildMessages() {
  const messages = {};

  // 01: flight confirmation with PDF itinerary and ICS
  const itineraryPdf = makeTextPdf('Itinerary XK7Q2P', [
    'SKYWARD AIR - ITINERARY',
    'Booking reference: XK7Q2P',
    '',
    'Passenger: Alex Rivera',
    'Flight: SW 214',
    'San Francisco (SFO) -> New York (JFK)',
    'Saturday, October 24, 2026',
    'Departure: 08:05 AM PDT',
    'Arrival: 04:32 PM EDT',
    'Seat: 14A, Economy',
    '',
    'Please arrive 2 hours before departure.',
  ]);
  const flightIcs = Buffer.from(
    crlfJoin([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Example Fixtures//Flight//EN',
      'BEGIN:VEVENT',
      'UID:sw214-xk7q2p@skyward-air.example.com',
      'DTSTAMP:20261012T161422Z',
      'DTSTART:20261024T150500Z',
      'DTEND:20261024T203200Z',
      'SUMMARY:SW 214: San Francisco to New York',
      'DESCRIPTION:Booking XK7Q2P\\, seat 14A',
      'LOCATION:San Francisco International Airport (SFO)',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ]),
    'utf-8',
  );
  messages['01-flight-confirmation.eml'] = emlWithAttachments({
    from: 'Skyward Air <bookings@skyward-air.example.com>',
    to: OWNER,
    date: 'Mon, 12 Oct 2026 09:14:22 -0700',
    subject: 'Your booking is confirmed: Skyward Air XK7Q2P',
    msgid: '<xk7q2p-confirmation@skyward-air.example.com>',
    body: crlfJoin([
      'Hi Alex,',
      '',
      'Your booking is confirmed. Booking reference: XK7Q2P',
      '',
      '  Flight:    SW 214 (Skyward Air)',
      '  From:      San Francisco (SFO)',
      '  To:        New York (JFK)',
      '  Date:      Saturday, October 24, 2026',
      '  Departs:   08:05 AM PDT',
      '  Arrives:   04:32 PM EDT',
      '  Passenger: Alex Rivera',
      '  Seat:      14A (Economy)',
      '',
      'Your itinerary is attached as a PDF, and a calendar file is',
      'attached so you can add the flight to your calendar.',
      '',
      'Safe travels,',
      'Skyward Air',
    ]),
    attachments: [
      { filename: 'itinerary.pdf', mime: 'application/pdf', data: itineraryPdf },
      { filename: 'flight.ics', mime: 'text/calendar', data: flightIcs },
    ],
  });

  // 02: dentist reminder
  messages['02-dentist-reminder.eml'] = emlSimple({
    from: 'Bright Smile Dental <reminders@bright-smile-dental.example.org>',
    to: OWNER,
    date: 'Fri, 09 Oct 2026 10:00:05 -0700',
    subject: 'Reminder: dental cleaning on Thursday, October 22 at 2:30 PM',
    msgid: '<reminder-20261022@bright-smile-dental.example.org>',
    body: crlfJoin([
      'Hi Alex,',
      '',
      'This is a reminder of your upcoming appointment:',
      '',
      '  What:     Dental cleaning',
      '  When:     Thursday, October 22, 2026 at 2:30 PM',
      '  Where:    Bright Smile Dental, 456 Example Avenue, Suite 12',
      '  Dentist:  Dr. Emily Chen',
      '',
      'Need to reschedule? Use this link:',
      'https://www.example.com/reschedule/9f2k7q',
      '',
      'Please arrive 10 minutes early.',
      '- Bright Smile Dental',
    ]),
  });

  // 03: utility bill with PDF
  const billPdf = makeTextPdf('Bill Oct 2026', [
    'METRO POWER & LIGHT - BILL',
    'Account: 88214470',
    'Billing period: Sep 5, 2026 - Oct 4, 2026',
    '',
    'Usage: 612 kWh',
    'Amount due: $184.62',
    'Due date: November 5, 2026',
    '',
    'Pay at https://www.example.com/pay',
  ]);
  messages['03-utility-bill.eml'] = emlWithAttachments({
    from: 'Metro Power & Light <billing@metro-power-utility.example.net>',
    to: OWNER,
    date: 'Mon, 05 Oct 2026 08:30:11 -0700',
    subject: 'Your October bill is ready: $184.62 due November 5',
    msgid: '<bill-202610@metro-power-utility.example.net>',
    body: crlfJoin([
      'Hi Alex,',
      '',
      'Your October 2026 bill is ready.',
      '',
      '  Account:   88214470',
      '  Amount:    $184.62',
      '  Due date:  November 5, 2026',
      '  Usage:     612 kWh',
      '',
      'A detailed statement is attached as a PDF.',
      '',
      '- Metro Power & Light',
    ]),
    attachments: [{ filename: 'bill.pdf', mime: 'application/pdf', data: billPdf }],
  });

  // 04: landlord repair visit
  messages['04-landlord-repair.eml'] = emlSimple({
    from: 'Maria Santos <maria.santos@example.com>',
    to: OWNER,
    date: 'Sat, 10 Oct 2026 14:22:40 -0700',
    subject: 'Kitchen faucet repair visit',
    msgid: '<faucet-visit@maria.santos.example.com>',
    body: crlfJoin([
      'Hi Alex,',
      '',
      'The plumber can come by on Thursday, October 15 between',
      '9:00 AM and 12:00 PM to fix the kitchen faucet.',
      '',
      'Could you confirm that works for you? Someone needs to be',
      'home to let him in.',
      '',
      'Thanks,',
      'Maria',
    ]),
  });

  // 05: school newsletter with three dated events
  messages['05-school-newsletter.eml'] = emlSimple({
    from: 'Maple Grove Elementary <newsletter@maple-grove-school.example.org>',
    to: OWNER,
    date: 'Mon, 12 Oct 2026 07:00:00 -0700',
    subject: 'Maple Grove Weekly: October 12',
    msgid: '<weekly-20261012@maple-grove-school.example.org>',
    body: crlfJoin([
      'Maple Grove Weekly - October 12, 2026',
      '',
      'Upcoming events:',
      '',
      '1. Fall Fair - Sunday, October 18, 10:00 AM to 2:00 PM',
      '   on the school field. Games, food stalls, and a bake sale.',
      '',
      '2. Parent-teacher conferences - Friday and Saturday,',
      "   October 23-24. Sign up with your child's teacher.",
      '',
      '3. Science Night - Friday, November 6 at 6:00 PM in the',
      '   gym. Student projects on display.',
      '',
      '- Maple Grove Elementary',
    ]),
  });

  // 06: package delivery notice
  messages['06-package-delivery.eml'] = emlSimple({
    from: 'SwiftParcel <tracking@swiftparcel.example.com>',
    to: OWNER,
    date: 'Sun, 11 Oct 2026 18:45:33 -0700',
    subject: 'Your package arrives Tuesday, October 13',
    msgid: '<spx-884102-7719@swiftparcel.example.com>',
    body: crlfJoin([
      'Hi Alex,',
      '',
      'Good news: your package is on its way.',
      '',
      '  Tracking:  SPX-884102-7719',
      '  Arriving:  Tuesday, October 13, 2026',
      '  Shipped:   Portland, OR',
      '',
      'Track it here: https://www.example.com/track/SPX-884102-7719',
      '',
      '- SwiftParcel',
    ]),
  });

  // 07: dinner plans with two date options
  messages['07-dinner-plans.eml'] = emlSimple({
    from: 'Jordan Lee <jordan.lee@example.com>',
    to: OWNER,
    date: 'Fri, 09 Oct 2026 19:03:17 -0700',
    subject: 'Dinner next week?',
    msgid: '<dinner-oct@jordan.lee.example.com>',
    body: crlfJoin([
      'Hi Alex,',
      '',
      'Want to grab dinner next week? I was thinking of The Copper',
      'Kettle downtown. Two options:',
      '',
      '  - Friday, October 16 at 7:00 PM',
      '  - Saturday, October 17 at 7:00 PM',
      '',
      'Let me know which works, or suggest another day.',
      '',
      'Jordan',
    ]),
  });

  // 08: receipt with CSV attachment
  const receiptCsv = Buffer.from(
    [
      'item,quantity,unit_price,total',
      'Whole wheat bread,2,3.49,6.98',
      'Free-range eggs (dozen),1,5.29,5.29',
      'Whole milk (gallon),1,4.19,4.19',
      'Bananas (bunch),2,1.29,2.58',
      'Chicken breast (lb),3,6.99,20.97',
      'Orange juice (64 oz),1,4.49,4.49',
      'Paper towels (pack),1,3.33,3.33',
      '',
    ].join('\n'),
    'utf-8',
  );
  messages['08-receipt.eml'] = emlWithAttachments({
    from: 'Corner Market <receipts@corner-market.example.net>',
    to: OWNER,
    date: 'Sat, 10 Oct 2026 12:15:44 -0700',
    subject: 'Your receipt from Corner Market',
    msgid: '<receipt-20261010@corner-market.example.net>',
    body: crlfJoin([
      'Hi Alex,',
      '',
      'Thanks for shopping with us on October 10, 2026.',
      '',
      '  Total: $47.83',
      '',
      'An itemized list is attached as a CSV file.',
      '',
      '- Corner Market',
    ]),
    attachments: [{ filename: 'receipt.csv', mime: 'text/csv', data: receiptCsv }],
  });

  // 09: phishing-style message (flag, do not act)
  messages['09-phishing-warning.eml'] = emlSimple({
    from: '"Account Security" <security-alert@amaz0n-verify.example.com>',
    to: OWNER,
    date: 'Sun, 11 Oct 2026 03:17:29 -0700',
    subject: 'URGENT: Verify your password within 24 hours',
    msgid: '<urgent-verify-9912@amaz0n-verify.example.com>',
    body: crlfJoin([
      'Dear customer,',
      '',
      'We detected a suspicious login to your account from an',
      'unknown device. Your account will be locked in 24 hours',
      'unless you verify now.',
      '',
      'Click here to verify your password:',
      'http://amaz0n-verify.example.com/login?user=alex.rivera',
      '',
      'Enter your password on the page to keep your account active.',
      '',
      'Account Security Team',
    ]),
  });

  // 10a/b/c: thread of three where the last changes the plan
  messages['10a-trip-plan.eml'] = emlSimple({
    from: 'Sam Patel <sam.patel@example.com>',
    to: OWNER,
    date: 'Wed, 07 Oct 2026 11:00:00 -0700',
    subject: 'Weekend hiking trip',
    msgid: '<hike-oct17@sam.patel.example.com>',
    body: crlfJoin([
      'Hi Alex,',
      '',
      'Want to do a hike on Saturday, October 17? I was thinking',
      'Pine Ridge Trail - it is about 6 miles round trip with great',
      'views. We could start around 8 AM.',
      '',
      'Let me know what you think.',
      '',
      'Sam',
    ]),
  });
  messages['10b-trip-plan-reply.eml'] = emlSimple({
    from: OWNER,
    to: 'Sam Patel <sam.patel@example.com>',
    date: 'Wed, 07 Oct 2026 15:30:00 -0700',
    subject: 'Re: Weekend hiking trip',
    msgid: '<re-hike-oct17@alex.rivera.example.com>',
    body: crlfJoin([
      'Hi Sam,',
      '',
      'Sounds great. Pine Ridge Trail on Saturday the 17th works',
      'for me. 8 AM start is fine - want me to bring anything?',
      '',
      'Alex',
    ]),
    extraHeaders: ['In-Reply-To: <hike-oct17@sam.patel.example.com>', 'References: <hike-oct17@sam.patel.example.com>'],
  });
  messages['10c-trip-plan-change.eml'] = emlSimple({
    from: 'Sam Patel <sam.patel@example.com>',
    to: OWNER,
    date: 'Fri, 09 Oct 2026 09:12:00 -0700',
    subject: 'Re: Weekend hiking trip',
    msgid: '<re2-hike-oct17@sam.patel.example.com>',
    body: crlfJoin([
      'Hi Alex,',
      '',
      'Change of plans: Pine Ridge Trail is closed for maintenance',
      "this weekend. Let's do Cedar Lake Loop instead - it is a",
      'similar distance. Meet at 8:00 AM at the Cedar Lake',
      'trailhead parking lot.',
      '',
      'Sam',
    ]),
    extraHeaders: [
      'In-Reply-To: <re-hike-oct17@alex.rivera.example.com>',
      'References: <hike-oct17@sam.patel.example.com> <re-hike-oct17@alex.rivera.example.com>',
    ],
  });

  // 11: calendar invite with ICS
  const inviteIcs = Buffer.from(
    crlfJoin([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Example Fixtures//Invite//EN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:q4-planning-20261014@priya.nair.example.com',
      'DTSTAMP:20261012T150000Z',
      'DTSTART:20261014T170000Z',
      'DTEND:20261014T180000Z',
      'SUMMARY:Q4 Planning Session',
      'DESCRIPTION:Quarterly planning with the team.',
      'LOCATION:Conference Room B',
      'ORGANIZER;CN=Priya Nair:mailto:priya.nair@example.com',
      'ATTENDEE;CN=Alex Rivera:mailto:alex.rivera@example.com',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ]),
    'utf-8',
  );
  messages['11-calendar-invite.eml'] = emlWithAttachments({
    from: 'Priya Nair <priya.nair@example.com>',
    to: OWNER,
    date: 'Mon, 12 Oct 2026 08:00:00 -0700',
    subject: 'Invitation: Q4 Planning Session @ Wed Oct 14, 2026 10:00 AM - 11:00 AM (PDT)',
    msgid: '<q4-planning-invite@priya.nair.example.com>',
    body: crlfJoin([
      'Hi Alex,',
      '',
      'You are invited to:',
      '',
      '  Q4 Planning Session',
      '  Wednesday, October 14, 2026',
      '  10:00 AM - 11:00 AM PDT',
      '  Conference Room B / https://www.example.com/meet/q4planning',
      '',
      'Agenda is attached as a calendar invite.',
      '',
      'Best,',
      'Priya',
    ]),
    attachments: [{ filename: 'invite.ics', mime: 'text/calendar', data: inviteIcs }],
  });

  // 12: scanned note as PNG
  const notePng = makeNotePng([
    'Plumber: Fix-It Plumbing, 555-0142.',
    'Call before Thursday about the',
    'kitchen faucet.',
  ]);
  messages['12-scanned-note.eml'] = emlWithAttachments({
    from: OWNER,
    to: OWNER,
    date: 'Sun, 11 Oct 2026 20:05:00 -0700',
    subject: 'Scanned note: plumber contact',
    msgid: '<scanned-note-001@alex.rivera.example.com>',
    body: crlfJoin(['Scanned from my desk - keeping a copy here.', '', '- Alex']),
    attachments: [{ filename: 'note.png', mime: 'image/png', data: notePng }],
  });

  return messages;
}

function main() {
  const messages = buildMessages();
  for (const name of Object.keys(messages).sort()) {
    writeFileSync(join(OUT_DIR, name), messages[name], 'utf8');
    console.log('wrote', name);
  }
}

main();
