import { inflateRawSync } from 'node:zlib';
import {
  createStructuredDocumentDocx,
  DOCUMENT_REPORT_MAX_NOTES,
  DOCUMENT_REPORT_MAX_ROWS,
  DOCUMENT_REPORT_MAX_SECTIONS,
  type StructuredDocumentReport,
  type StructuredReportSection,
} from '../../../src/documents/documentRenderer';

/**
 * Minimal zip reader for test assertions: locates word/document.xml through
 * the central directory and inflates it. The docx library always writes
 * stored-as-deflate entries, so a full zip implementation is unnecessary.
 */
function readDocumentXml(docx: Buffer): string {
  const view = new DataView(docx.buffer, docx.byteOffset, docx.byteLength);
  const EOCD_SIG = 0x0605_4b50;
  const CD_SIG = 0x0201_4b50;
  const LOCAL_SIG = 0x0403_4b50;
  let eocd = -1;
  for (let i = docx.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('test fixture: no zip end-of-central-directory found');
  }
  const cdCount = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  for (let entry = 0; entry < cdCount; entry += 1) {
    if (view.getUint32(cdOffset, true) !== CD_SIG) {
      throw new Error('test fixture: corrupt zip central directory');
    }
    const nameLength = view.getUint16(cdOffset + 28, true);
    const extraLength = view.getUint16(cdOffset + 30, true);
    const commentLength = view.getUint16(cdOffset + 32, true);
    const localOffset = view.getUint32(cdOffset + 42, true);
    const name = docx.subarray(cdOffset + 46, cdOffset + 46 + nameLength).toString('utf8');
    if (name === 'word/document.xml') {
      if (view.getUint32(localOffset, true) !== LOCAL_SIG) {
        throw new Error('test fixture: corrupt zip local header');
      }
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressedSize = view.getUint32(cdOffset + 20, true);
      const method = view.getUint16(cdOffset + 10, true);
      const data = docx.subarray(dataStart, dataStart + compressedSize);
      const xml = method === 8 ? inflateRawSync(data) : data;
      return xml.toString('utf8');
    }
    cdOffset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('test fixture: word/document.xml not found');
}

function makeRow(index: number): StructuredDocumentReport['sections'][number]['rows'][number] {
  return {
    label: `Line item ${String(index)}`,
    value: `$${String(1000 + index)}.00`,
    status: 'included',
    sources: [`statement.pdf p.${String((index % 9) + 1)} l.2`],
  };
}

function makeSection(heading: string, rowCount: number, startIndex: number): StructuredReportSection {
  return {
    heading,
    rows: Array.from({ length: rowCount }, (_, i) => makeRow(startIndex + i)),
  };
}

function countOccurrences(xml: string, needle: string): number {
  return xml.split(needle).length - 1;
}

describe('createStructuredDocumentDocx report modes', () => {
  it('keeps the compact bounds by default: sections, rows, and notes', async () => {
    const tooManySections: StructuredDocumentReport = {
      title: 'T',
      summary: 'S',
      sections: [makeSection('A', 1, 0), makeSection('B', 1, 1), makeSection('C', 1, 2)],
      notes: [],
    };
    await expect(createStructuredDocumentDocx(tooManySections)).rejects.toThrow(
      /compact mode limits.*max 2 sections, 16 rows total, 4 notes/,
    );

    const tooManyRows: StructuredDocumentReport = {
      title: 'T',
      summary: 'S',
      sections: [makeSection('A', 9, 0), makeSection('B', 8, 9)],
      notes: [],
    };
    await expect(createStructuredDocumentDocx(tooManyRows)).rejects.toThrow(/compact mode limits/);

    const tooManyNotes: StructuredDocumentReport = {
      title: 'T',
      summary: 'S',
      sections: [makeSection('A', 1, 0)],
      notes: ['a', 'b', 'c', 'd', 'e'],
    };
    await expect(createStructuredDocumentDocx(tooManyNotes)).rejects.toThrow(/compact mode limits/);
  });

  it('tells the caller to use full mode when compact bounds are exceeded', async () => {
    const report: StructuredDocumentReport = {
      title: 'T',
      summary: 'S',
      sections: [makeSection('A', DOCUMENT_REPORT_MAX_ROWS + 1, 0)],
      notes: [],
    };
    await expect(createStructuredDocumentDocx(report)).rejects.toThrow(/Use mode "full" for longer reports/);
  });

  it('renders a report exactly at the compact caps', async () => {
    const report: StructuredDocumentReport = {
      title: 'T',
      summary: 'S',
      sections: [makeSection('A', 8, 0), makeSection('B', 8, 8)],
      notes: ['a', 'b', 'c', 'd'],
    };
    const docx = await createStructuredDocumentDocx(report);
    expect(docx.subarray(0, 2).toString('binary')).toBe('PK');
    const xml = readDocumentXml(docx);
    expect(countOccurrences(xml, 'Line item')).toBe(DOCUMENT_REPORT_MAX_ROWS);
  });

  it('renders a 208-row financial plan end to end in full mode', async () => {
    const sections = ['Income', 'Expenses', 'Accounts', 'Tax', 'Estate', 'Insurance', 'Timeline', 'Assumptions'].map(
      (heading, i) => makeSection(heading, 26, i * 26),
    );
    const report: StructuredDocumentReport = {
      title: 'CFP Financial Plan',
      summary: 'Synthetic 208-row plan used to exercise full-report mode.',
      sections,
      notes: Array.from({ length: 10 }, (_, i) => `Methodology note ${String(i + 1)}.`),
    };
    const docx = await createStructuredDocumentDocx(report, { mode: 'full' });
    expect(docx.subarray(0, 2).toString('binary')).toBe('PK');
    const xml = readDocumentXml(docx);
    // Every section heading and every one of the 208 rows made it into the document.
    // (Word may split a heading across multiple text runs, so check the tag-stripped text.)
    const bodyText = xml.replace(/<[^>]+>/g, '');
    for (const heading of ['Income', 'Expenses', 'Accounts', 'Tax', 'Estate', 'Insurance', 'Timeline', 'Assumptions']) {
      expect(bodyText).toContain(heading);
    }
    expect(countOccurrences(xml, 'Line item')).toBe(208);
    expect(countOccurrences(bodyText, 'included')).toBe(208);
    expect(bodyText).toContain('Methodology note 10.');
  });

  it('keeps per-field renderer caps in full mode', async () => {
    const longLabel = 'x'.repeat(161);
    const report: StructuredDocumentReport = {
      title: 'T',
      summary: 'S',
      sections: [{ heading: 'A', rows: [{ label: longLabel, value: 'v', status: 'info', sources: [] }] }],
      notes: [],
    };
    await expect(createStructuredDocumentDocx(report, { mode: 'full' })).rejects.toThrow(
      /Report row exceeds its caps: label 160 characters/,
    );
  });

  it('documents the compact caps as exported constants', () => {
    expect(DOCUMENT_REPORT_MAX_SECTIONS).toBe(2);
    expect(DOCUMENT_REPORT_MAX_ROWS).toBe(16);
    expect(DOCUMENT_REPORT_MAX_NOTES).toBe(4);
  });
});
