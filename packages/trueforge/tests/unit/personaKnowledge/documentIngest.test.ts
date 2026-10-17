import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateRawSync } from 'node:zlib';
import { Response as UndiciResponse } from 'undici';

import {
  extractTextFromUpload,
  fetchUrlSnapshot,
  MAX_UPLOAD_BYTES,
  pinnedDispatcher,
} from '../../../src/personaKnowledge/documentIngest';

const textBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** CRC-32 (IEEE) over UTF-8 bytes, for the hand-rolled stored zip below. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Minimal ZIP writer: stored (uncompressed) entries only. Enough for a
 * synthetic .docx — mammoth only needs the three standard parts.
 */
function storedZip(entries: Array<[name: string, content: string]>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (target: Uint8Array[], bytes: Uint8Array): void => {
    target.push(bytes);
  };
  for (const [name, content] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const dataBytes = new TextEncoder().encode(content);
    const crc = crc32(dataBytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, dataBytes.length, true);
    local.setUint32(22, dataBytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    push(chunks, new Uint8Array(local.buffer));
    push(chunks, nameBytes);
    push(chunks, dataBytes);
    const headerLength = 30 + nameBytes.length + dataBytes.length;

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(10, 0, true); // stored
    dir.setUint32(16, crc, true);
    dir.setUint32(20, dataBytes.length, true);
    dir.setUint32(24, dataBytes.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);
    push(central, new Uint8Array(dir.buffer));
    push(central, nameBytes);
    offset += headerLength;
  }
  const centralStart = offset;
  const centralSize = central.reduce((sum, bytes) => sum + bytes.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  const total = centralStart + centralSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...chunks, ...central, new Uint8Array(end.buffer)]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * One deflated entry whose local header and central directory both claim
 * `declaredSize` uncompressed bytes, whatever the data really inflates to.
 */
function deflatedZip(name: string, content: Uint8Array, declaredSize: number): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const compressed = deflateRawSync(content);
  const crc = crc32(content);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(8, 8, true); // deflate
  local.setUint32(14, crc, true);
  local.setUint32(18, compressed.length, true);
  local.setUint32(22, declaredSize, true);
  local.setUint16(26, nameBytes.length, true);
  const dir = new DataView(new ArrayBuffer(46));
  dir.setUint32(0, 0x02014b50, true);
  dir.setUint16(10, 8, true); // deflate
  dir.setUint32(16, crc, true);
  dir.setUint32(20, compressed.length, true);
  dir.setUint32(24, declaredSize, true);
  dir.setUint16(28, nameBytes.length, true);
  dir.setUint32(42, 0, true);
  const centralStart = 30 + nameBytes.length + compressed.length;
  const centralSize = 46 + nameBytes.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  const parts = [
    new Uint8Array(local.buffer),
    nameBytes,
    compressed,
    new Uint8Array(dir.buffer),
    nameBytes,
    new Uint8Array(end.buffer),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function fakeFetch(handler: (url: string) => UndiciResponse): (url: unknown) => Promise<UndiciResponse> {
  return async (url: unknown) => handler(String(url));
}

function htmlResponse(html: string, status = 200, headers: Record<string, string> = {}): UndiciResponse {
  return new UndiciResponse(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

/**
 * Minimal ZIP64 writer: stored entries with a zip64 end-of-central-directory,
 * so the classic EOCD carries 0xFFFF/0xFFFFFFFF sentinels. `declaredSizes`
 * overrides the uncompressed size the central directory claims per entry —
 * the bomb test lies about it while the bytes stay tiny.
 */
function storedZip64(entries: Array<[name: string, content: string]>, declaredSizes?: bigint[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const enc = new TextEncoder();
  let offset = 0;
  entries.forEach(([name, content], index) => {
    const nameBytes = enc.encode(name);
    const dataBytes = enc.encode(content);
    const crc = crc32(dataBytes);
    const declared = declaredSizes?.[index] ?? BigInt(dataBytes.length);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, dataBytes.length, true);
    local.setUint32(22, dataBytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, dataBytes);

    // Zip64 extra field: id 0x0001. Per the spec it carries every field whose
    // 32-bit counterpart is the sentinel, in field order — uncompressed size
    // first, then compressed size. Both are sentinels here.
    const extra = new DataView(new ArrayBuffer(20));
    extra.setUint16(0, 0x0001, true);
    extra.setUint16(2, 16, true);
    extra.setBigUint64(4, declared, true);
    extra.setBigUint64(12, BigInt(dataBytes.length), true);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(10, 0, true); // stored
    dir.setUint32(16, crc, true);
    dir.setUint32(20, 0xffff_ffff, true); // compressed size: zip64 sentinel
    dir.setUint32(24, 0xffff_ffff, true); // uncompressed size: zip64 sentinel
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint16(30, 20, true); // extra field length
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), nameBytes, new Uint8Array(extra.buffer));
    offset += 30 + nameBytes.length + dataBytes.length;
  });
  const centralStart = offset;
  const centralSize = central.reduce((sum, bytes) => sum + bytes.length, 0);

  const zip64EocdOffset = centralStart + centralSize;
  const zeocd = new DataView(new ArrayBuffer(56));
  zeocd.setUint32(0, 0x06064b50, true);
  zeocd.setBigUint64(4, BigInt(44), true);
  zeocd.setUint16(12, 20, true);
  zeocd.setUint16(14, 20, true);
  zeocd.setUint32(16, 0, true);
  zeocd.setUint32(20, 0, true);
  zeocd.setBigUint64(24, BigInt(entries.length), true);
  zeocd.setBigUint64(32, BigInt(entries.length), true);
  zeocd.setBigUint64(40, BigInt(centralSize), true);
  zeocd.setBigUint64(48, BigInt(centralStart), true);

  const locator = new DataView(new ArrayBuffer(20));
  locator.setUint32(0, 0x07064b50, true);
  locator.setUint32(4, 0, true);
  locator.setBigUint64(8, BigInt(zip64EocdOffset), true);
  locator.setUint32(16, 1, true);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 0xffff, true);
  end.setUint16(10, 0xffff, true);
  end.setUint32(12, 0xffff_ffff, true);
  end.setUint32(16, 0xffff_ffff, true);

  const parts = [
    ...chunks,
    ...central,
    new Uint8Array(zeocd.buffer),
    new Uint8Array(locator.buffer),
    new Uint8Array(end.buffer),
  ];
  const out = new Uint8Array(parts.reduce((sum, bytes) => sum + bytes.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Synthetic PDF with N single-line pages; pdfjs-dist rebuilds the missing xref. */
function manyPagePdf(pageCount: number): Uint8Array {
  const fontObj = 3 + pageCount * 2;
  const kids: string[] = [];
  const parts: string[] = [];
  for (let p = 1; p <= pageCount; p += 1) {
    const pageObj = 3 + (p - 1) * 2;
    kids.push(`${String(pageObj)} 0 R`);
    const stream = `BT /F1 24 Tf 100 700 Td (Page ${String(p)} marker) Tj ET`;
    parts.push(
      `${String(pageObj)} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]` +
        `/Contents ${String(pageObj + 1)} 0 R/Resources<</Font<</F1 ${String(fontObj)} 0 R>>>>>>endobj`,
      `${String(pageObj + 1)} 0 obj<</Length ${String(stream.length)}>>stream\n${stream}\nendstream\nendobj`,
    );
  }
  const pdf = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    `2 0 obj<</Type/Pages/Kids[${kids.join(' ')}]/Count ${String(pageCount)}>>endobj`,
    ...parts,
    `${String(fontObj)} 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`,
    'trailer<</Root 1 0 R>>',
  ].join('\n');
  return textBytes(pdf);
}

describe('extractTextFromUpload', () => {
  it('reads plain text and markdown uploads', async () => {
    const txt = await extractTextFromUpload({ filename: 'notes.txt', bytes: textBytes('Hello library') });
    expect(txt.kind).toBe('txt');
    expect(txt.text).toContain('Hello library');

    const md = await extractTextFromUpload({ filename: 'notes.md', bytes: textBytes('# Title\n\nBody') });
    expect(md.kind).toBe('md');
    expect(md.text).toContain('Title');
  });

  it('extracts text from a PDF upload', async () => {
    // Minimal one-page PDF; pdfjs-dist rebuilds the missing xref table.
    const pdf = [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
      '4 0 obj<</Length 58>>stream',
      'BT /F1 24 Tf 100 700 Td (Hello synthetic world) Tj ET',
      'endstream',
      'endobj',
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
      'trailer<</Root 1 0 R>>',
    ].join('\n');
    const extracted = await extractTextFromUpload({ filename: 'hello.pdf', bytes: textBytes(pdf) });
    expect(extracted.kind).toBe('pdf');
    expect(extracted.text).toContain('Hello synthetic world');
  });

  it('extracts text from a Word upload', async () => {
    // Minimal .docx: a stored (uncompressed) zip with the three parts mammoth
    // needs. Hand-rolled so the test needs no zip dependency.
    const documentXml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>Sold the solo project for twenty million dollars</w:t></w:r></w:p></w:body></w:document>';
    const docx = storedZip([
      [
        '[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
      ],
      [
        '_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
      ],
      ['word/document.xml', documentXml],
    ]);
    const extracted = await extractTextFromUpload({ filename: 'exit-story.docx', bytes: docx });
    expect(extracted.kind).toBe('docx');
    expect(extracted.text).toContain('twenty million dollars');
  });

  it('refuses a zip bomb before inflating it', async () => {
    const docx = storedZip([['word/document.xml', '<w:document/>']]);
    // Lie in the central directory: claim 100 MB uncompressed while the
    // actual entry is tiny. The gate must fire before mammoth inflates.
    const view = new DataView(docx.buffer, docx.byteOffset, docx.byteLength);
    for (let i = 0; i + 4 <= docx.byteLength; i += 1) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 100 * 1024 * 1024, true);
      }
    }
    await expect(extractTextFromUpload({ filename: 'bomb.docx', bytes: docx })).rejects.toThrow(/enormous/);
  });

  it('refuses a zip bomb whose headers understate its real size', async () => {
    // 64 MiB of zeros deflates to a few kilobytes; every header claims 1 KiB.
    const docx = deflatedZip('word/document.xml', new Uint8Array(64 * 1024 * 1024), 1024);
    expect(docx.byteLength).toBeLessThan(MAX_UPLOAD_BYTES);
    await expect(extractTextFromUpload({ filename: 'understated.docx', bytes: docx })).rejects.toThrow(/enormous/);
  });

  it('refuses a .docx whose zip structure cannot be checked', async () => {
    const docx = storedZip([['word/document.xml', '<w:document/>']]);
    const view = new DataView(docx.buffer, docx.byteOffset, docx.byteLength);
    // Point the end record at a central directory that is not there.
    view.setUint32(docx.byteLength - 22 + 16, 1, true);
    await expect(extractTextFromUpload({ filename: 'broken.docx', bytes: docx })).rejects.toThrow(
      /could not be opened as a Word document/,
    );
  });

  it('refuses a zip64 zip bomb before inflating it', async () => {
    // The classic EOCD carries 0xFFFF/0xFFFFFFFF sentinels; the real sizes
    // live in the zip64 records. A scanner that can't read zip64 fails open
    // while the zip reader parses the archive just fine.
    const docx = storedZip64([['word/document.xml', '<w:document/>']], [BigInt(1024 * 1024 * 1024)]);
    expect(docx.byteLength).toBeLessThan(1024);
    await expect(extractTextFromUpload({ filename: 'bomb64.docx', bytes: docx })).rejects.toThrow(/enormous/);
  });

  it('indexes a small valid zip64 .docx', async () => {
    const documentXml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>zip64 archives are first-class</w:t></w:r></w:p></w:body></w:document>';
    const docx = storedZip64([
      [
        '[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
      ],
      [
        '_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
      ],
      ['word/document.xml', documentXml],
    ]);
    const extracted = await extractTextFromUpload({ filename: 'z64.docx', bytes: docx });
    expect(extracted.kind).toBe('docx');
    expect(extracted.text).toContain('zip64 archives are first-class');
  });

  it('caps PDF pages at 300 with an honest note', async () => {
    const pdf = manyPagePdf(320);
    const extracted = await extractTextFromUpload({ filename: 'long.pdf', bytes: pdf });
    expect(extracted.kind).toBe('pdf');
    expect(extracted.text).toContain('Page 300 marker');
    expect(extracted.text).not.toContain('Page 301 marker');
    expect(extracted.note).toBe('Only the first 300 of 320 pages were indexed.');
  });

  it('rejects empty and unsupported uploads with plain-English errors', async () => {
    await expect(extractTextFromUpload({ filename: 'empty.txt', bytes: new Uint8Array(0) })).rejects.toThrow(/empty/);
    await expect(
      extractTextFromUpload({ filename: 'photo.png', bytes: textBytes('not an image really') }),
    ).rejects.toThrow(/PDF, Word/);
  });
});

describe('fetchUrlSnapshot SSRF guards', () => {
  const publicResolver = async () => ['93.184.216.34'];
  const privateResolver = async () => ['10.1.2.3'];

  it('blocks private IP literals without any network call', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error('must not be called');
    });
    // Echo resolver: an IP literal resolves to itself.
    const echoResolver = async (hostname: string) => [hostname];
    await expect(
      fetchUrlSnapshot('http://127.0.0.1/admin', { fetchImpl, resolveAddresses: echoResolver }),
    ).rejects.toThrow(/private or internal/);
  });

  it('blocks every IANA special-purpose range, not just the famous private ones', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error('must not be called');
    });
    const echoResolver = async (hostname: string) => [hostname];
    // CGNAT, IETF protocol assignments, benchmarking, reserved, docs ranges…
    for (const host of ['100.64.0.1', '192.0.0.1', '198.18.0.1', '240.0.0.1', '203.0.113.7']) {
      await expect(fetchUrlSnapshot(`http://${host}/`, { fetchImpl, resolveAddresses: echoResolver })).rejects.toThrow(
        /private or internal/,
      );
    }
    // …and their IPv6 counterparts: NAT64 prefix, 6to4, discard, mapped v4.
    for (const host of ['64:ff9b::808:808', '2002::1', '::ffff:93.184.216.34', 'fe80::1']) {
      await expect(
        fetchUrlSnapshot(`http://[${host}]/`, { fetchImpl, resolveAddresses: echoResolver }),
      ).rejects.toThrow(/private or internal/);
    }
  });

  it('blocks hostnames that resolve to private addresses', async () => {
    const fetchImpl = fakeFetch(() => htmlResponse('<html><body>hi</body></html>'));
    await expect(
      fetchUrlSnapshot('https://internal.example.com/', { fetchImpl, resolveAddresses: privateResolver }),
    ).rejects.toThrow(/private or internal/);
  });

  it('re-validates every redirect hop', async () => {
    const fetchImpl = fakeFetch((url: string) => {
      if (url === 'https://example.com/start') {
        return htmlResponse('', 302, { location: 'http://169.254.169.254/latest/meta-data' });
      }
      throw new Error(`unexpected fetch of ${url}`);
    });
    await expect(
      fetchUrlSnapshot('https://example.com/start', { fetchImpl, resolveAddresses: publicResolver }),
    ).rejects.toThrow(/private or internal/);
  });

  it('rejects non-http(s) schemes, credentials, and odd ports before fetching', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error('must not be called');
    });
    const options = { fetchImpl, resolveAddresses: publicResolver };
    await expect(fetchUrlSnapshot('ftp://example.com/file', options)).rejects.toThrow(/http/);
    await expect(fetchUrlSnapshot('https://user:pass@example.com/', options)).rejects.toThrow(/username/);
    await expect(fetchUrlSnapshot('https://example.com:8443/', options)).rejects.toThrow(/port/);
  });

  it('snapshots page text and title', async () => {
    const fetchImpl = fakeFetch(() =>
      htmlResponse('<html><head><title>Solo Exit Story</title></head><body><p>Sold for $20M.</p></body></html>'),
    );
    const snapshot = await fetchUrlSnapshot('https://example.com/story', {
      fetchImpl,
      resolveAddresses: publicResolver,
    });
    expect(snapshot.finalUrl).toBe('https://example.com/story');
    expect(snapshot.title).toBe('Solo Exit Story');
    expect(snapshot.text).toContain('Sold for $20M');
  });

  it('pins the connection to the validated address (DNS-rebinding guard)', async () => {
    const seen: unknown[] = [];
    const fetchImpl = async (_url: unknown, init: unknown): Promise<UndiciResponse> => {
      seen.push(init);
      return htmlResponse('<html><body>pinned</body></html>');
    };
    await fetchUrlSnapshot('https://example.com/story', { fetchImpl, resolveAddresses: publicResolver });
    expect(seen).toHaveLength(1);
    // The fetch must carry a dispatcher whose connection cannot be re-routed
    // by DNS after validation — this is the rebinding pin, not decoration.
    expect(seen[0]).toMatchObject({ dispatcher: expect.anything() });
  });

  it('reaches the pinned address even when the hostname does not resolve', async () => {
    // Local server on loopback; the hostname below is unresolvable, so a
    // successful request proves the TCP destination came from the pin, not DNS.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pinned-ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const dispatcher = pinnedDispatcher('127.0.0.1');
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        dispatcher.dispatch(
          {
            origin: `http://unresolvable-rebinding-test.invalid:${String(port)}`,
            path: '/',
            method: 'GET',
          },
          {
            onConnect: abort => {
              void abort;
            },
            onHeaders: () => true,
            onData: chunk => {
              chunks.push(Buffer.from(chunk));
              return true;
            },
            onComplete: () => resolve(Buffer.concat(chunks).toString('utf-8')),
            onError: reject,
          },
        );
      });
      expect(body).toBe('pinned-ok');
    } finally {
      await dispatcher.close().catch(() => undefined);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
