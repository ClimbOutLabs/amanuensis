import { createHash } from 'node:crypto';
import {
  CREATE_DOCUMENT_REPORT_TOOL_NAME,
  DocumentTools,
  EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
  SUMMARIZE_NET_WORTH_TOOL_NAME,
} from '../../../src/core/capabilities/builtins/DocumentTools';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import {
  extractDocumentText,
  MAX_BYTES_PER_DOCUMENT,
  MAX_CHARS_PER_DOCUMENT,
  MAX_DOCUMENT_FILES,
  MAX_TOTAL_DOCUMENT_BYTES,
  sourceForLine,
  type DocumentExtraction,
  type ExtractedDocument,
} from '../../../src/documents/documentExtraction';
import { createStructuredDocumentDocx } from '../../../src/documents/documentRenderer';
import {
  netWorthAsDocumentReport,
  summarizeNetWorth,
  type NetWorthObservationInput,
} from '../../../src/documents/netWorthReport';
import { makeStubPublicSandbox } from '../harnessMocks';

function makePdf(pageLines: readonly (readonly string[])[]): Buffer {
  const pageCount = pageLines.length;
  const firstContent = 3 + pageCount;
  const fontObject = firstContent + pageCount;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageLines.map((_, index) => `${3 + index} 0 R`).join(' ')}] /Count ${String(pageCount)} >>`,
  ];
  for (let index = 0; index < pageCount; index += 1) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${firstContent + index} 0 R >>`,
    );
  }
  for (const lines of pageLines) {
    const source = lines
      .map(
        (line, index) =>
          `${index === 0 ? 'BT /F1 12 Tf 72 720 Td' : '0 -18 Td'} (${line.replace(/[()\\]/g, character => `\\${character}`)}) Tj`,
      )
      .concat(lines.length > 0 ? ['ET'] : [])
      .join('\n');
    const bytes = Buffer.from(source, 'latin1');
    objects.push(`<< /Length ${String(bytes.length)} >>\nstream\n${source}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(chunks.reduce((total, chunk) => total + chunk.length, 0));
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`, 'latin1'));
  }
  const xrefOffset = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const xref = [`xref\n0 ${String(objects.length + 1)}`, '0000000000 65535 f '];
  for (let index = 1; index < offsets.length; index += 1) {
    xref.push(`${String(offsets[index]).padStart(10, '0')} 00000 n `);
  }
  xref.push(
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`,
  );
  chunks.push(Buffer.from(xref.join('\n'), 'latin1'));
  return Buffer.concat(chunks);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeEvidenceDocument(filename: string, path: string, lines: string[]): ExtractedDocument {
  return {
    filename,
    path,
    sha256: hash(filename),
    extraction_mode: 'text',
    pages: [
      {
        page_number: 1,
        extraction_mode: 'text',
        lines: lines.map((text, index) => ({ line_number: index + 1, text })),
      },
    ],
    issue: null,
  };
}

function observation(
  document: ExtractedDocument,
  line: number,
  input: Omit<NetWorthObservationInput, 'source'>,
): NetWorthObservationInput {
  const text = document.pages[0]?.lines.find(candidate => candidate.line_number === line)?.text;
  const money = text?.match(/(?:USD\s*)?\$\s*\d[\d,]*(?:\.\d{1,2})?|\d{1,3}(?:,\d{3})*\.\d{2}/i);
  const start = money?.index;
  const source =
    text !== undefined && money?.[0] !== undefined && start !== undefined
      ? sourceForLine({ document, page: 1, line, start, end: start + money[0].length })
      : null;
  if (source === null) {
    throw new Error('test fixture source line missing');
  }
  return { ...input, source };
}

describe('local document pipeline', () => {
  it('preserves native multiline PDF text and OCRs only the empty mixed-PDF page', async () => {
    const pdf = makePdf([['Statement date: 2026-08-01', 'Checking account balance: $100.00'], []]);
    const ocrCalls: { pages: readonly number[] | undefined; kind: string }[] = [];
    const result = await extractDocumentText({
      files: [{ filename: 'mixed.pdf', path: 'uploads/mixed.pdf' }],
      downloadFile: async () => pdf,
      runNativePdfText: async () => ({
        total_pages: 2,
        pages: [
          { page_number: 1, text: 'Statement date: 2026-08-01\nChecking account balance: $100.00' },
          { page_number: 2, text: '' },
        ],
      }),
      runOcr: async input => {
        ocrCalls.push({ pages: input.pages, kind: input.kind });
        return [{ page_number: 2, text: 'Scanned table\nRetirement balance: $250.00' }];
      },
    });
    const document = result.documents[0];
    expect(document?.issue).toBeNull();
    expect(document?.pages).toHaveLength(2);
    expect(document?.pages[0]?.lines.map(line => line.text)).toEqual([
      'Statement date: 2026-08-01',
      'Checking account balance: $100.00',
    ]);
    expect(document?.pages[1]?.lines.map(line => line.text)).toEqual(['Scanned table', 'Retirement balance: $250.00']);
    expect(ocrCalls).toEqual([{ pages: [2], kind: 'pdf' }]);
  });

  it('keeps OCR page results keyed by page number and does not assume server OCR binaries', async () => {
    const calls: { pages: readonly number[] | undefined; content: Buffer }[] = [];
    const result = await extractDocumentText({
      files: [{ filename: 'screenshot.png', path: 'uploads/screenshot.png' }],
      downloadFile: async () => Buffer.from('synthetic image bytes'),
      runNativePdfText: async () => ({ total_pages: 0, pages: [] }),
      runOcr: async input => {
        calls.push({ pages: input.pages, content: Buffer.from(input.filePath) });
        return [{ page_number: 1, text: 'Account overview\nAvailable balance $99.01' }];
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pages).toBeUndefined();
    expect(result.documents[0]?.pages[0]?.lines[1]?.text).toBe('Available balance $99.01');
  });

  it('records a document issue when sandbox OCR fails', async () => {
    const result = await extractDocumentText({
      files: [{ filename: 'unreadable.png', path: 'uploads/unreadable.png' }],
      downloadFile: async () => Buffer.from('synthetic image bytes'),
      runNativePdfText: async () => ({ total_pages: 0, pages: [] }),
      runOcr: async () => {
        throw new Error('(exit code 1): tesseract failed');
      },
    });

    expect(result.documents[0]).toMatchObject({
      filename: 'unreadable.png',
      pages: [],
      issue: expect.stringContaining('tesseract failed'),
    });
  });

  it('bounds file count and extracted characters before returning evidence', async () => {
    const files = Array.from({ length: MAX_DOCUMENT_FILES + 1 }, (_, index) => ({
      filename: `image-${String(index)}.png`,
      path: `uploads/image-${String(index)}.png`,
    }));
    const result = await extractDocumentText({
      files,
      downloadFile: async () => Buffer.from('image'),
      runNativePdfText: async () => ({ total_pages: 0, pages: [] }),
      runOcr: async () => [{ page_number: 1, text: 'x'.repeat(MAX_CHARS_PER_DOCUMENT + 100) }],
    });
    expect(result.documents).toHaveLength(MAX_DOCUMENT_FILES + 1);
    expect(result.documents[MAX_DOCUMENT_FILES]?.issue).toContain('maximum');
    expect(result.documents[0]?.pages[0]?.lines[0]?.text.length).toBeLessThanOrEqual(MAX_CHARS_PER_DOCUMENT);
  });

  it('bounds materialized snapshots by the aggregate document byte limit', async () => {
    const sandbox = makeStubPublicSandbox();
    const content = Buffer.alloc(MAX_BYTES_PER_DOCUMENT);
    const verify = jest.fn(() => Promise.resolve());
    const cleanup = jest.fn(() => Promise.resolve());
    const snapshotLimits: (number | undefined)[] = [];
    jest.spyOn(sandbox, 'createDocumentSnapshot').mockImplementation(input => {
      snapshotLimits.push(input.maxBytes);
      return Promise.resolve({ filePath: input.filePath, content, verify, cleanup });
    });
    const tools = new DocumentTools(sandbox, NOOP_AGENT_TRACING);
    const aggregateFileCount = MAX_TOTAL_DOCUMENT_BYTES / MAX_BYTES_PER_DOCUMENT;
    const file_paths = Array.from(
      { length: aggregateFileCount + 1 },
      (_, index) => `/tmp/uploads/document-${String(index)}.txt`,
    );

    await tools.callTool({ name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME, arguments: { file_paths } });

    expect(snapshotLimits).toEqual(Array.from({ length: aggregateFileCount }, () => MAX_BYTES_PER_DOCUMENT));
    expect(verify).toHaveBeenCalledTimes(aggregateFileCount);
    expect(cleanup).toHaveBeenCalledTimes(aggregateFileCount);
  });

  it('rejects tampered provenance and excludes safe conflicts from deterministic draft totals', () => {
    const checking = makeEvidenceDocument('checking.pdf', 'uploads/checking.pdf', ['Checking balance $100.00']);
    const checkingCopy = makeEvidenceDocument('checking-copy.pdf', 'uploads/checking-copy.pdf', [
      'Checking balance $90.00',
    ]);
    const mortgage = makeEvidenceDocument('mortgage.pdf', 'uploads/mortgage.pdf', ['Mortgage balance $40.00']);
    const extraction: DocumentExtraction = { documents: [checking, checkingCopy, mortgage] };
    const validChecking = observation(checking, 1, {
      key: 'checking',
      label: 'Checking',
      classification: 'asset',
      amount_cents: 10000,
    });
    const conflictChecking = observation(checkingCopy, 1, {
      key: 'checking',
      label: 'Checking',
      classification: 'asset',
      amount_cents: 9000,
    });
    const validMortgage = observation(mortgage, 1, {
      key: 'mortgage',
      label: 'Mortgage',
      classification: 'liability',
      amount_cents: 4000,
    });
    const tampered = { ...validChecking, source: { ...validChecking.source, span_text: 'Checking balance $999.00' } };
    const report = summarizeNetWorth(extraction, [validChecking, conflictChecking, validMortgage, tampered]);
    expect(report.draft).toBe(true);
    expect(report.assets_cents).toBe(0);
    expect(report.liabilities_cents).toBe(4000);
    expect(report.entries.some(entry => entry.status === 'conflict')).toBe(true);
    expect(report.entries.some(entry => entry.status === 'uncertain')).toBe(true);
    expect(report.review_items.join(' ')).toContain('does not match extracted text');
  });

  it('excludes one cited span when it is assigned to multiple report entries', () => {
    const combined = makeEvidenceDocument('combined.pdf', 'uploads/combined.pdf', ['Combined balance $100.00']);
    const extraction: DocumentExtraction = { documents: [combined] };
    const first = observation(combined, 1, {
      key: 'checking',
      label: 'Checking',
      classification: 'asset',
      amount_cents: 10000,
    });
    const second = observation(combined, 1, {
      key: 'savings',
      label: 'Savings',
      classification: 'asset',
      amount_cents: 10000,
    });

    const report = summarizeNetWorth(extraction, [first, second]);

    expect(report.assets_cents).toBe(0);
    expect(report.entries).toHaveLength(2);
    expect(report.entries.every(entry => entry.status === 'conflict')).toBe(true);
    expect(report.review_items.join(' ')).toContain('same cited evidence');
  });

  it('does not accept an unrelated date token as monetary evidence', () => {
    const dated = makeEvidenceDocument('dated.pdf', 'uploads/dated.pdf', ['Statement date 2026-08-01']);
    const text = dated.pages[0]?.lines[0]?.text ?? '';
    const start = text.indexOf('2026');
    const source = sourceForLine({ document: dated, page: 1, line: 1, start, end: start + 4 });
    if (source === null) {
      throw new Error('test fixture source missing');
    }

    const report = summarizeNetWorth({ documents: [dated] }, [
      { key: 'checking', label: 'Checking', classification: 'asset', amount_cents: 202600, source },
    ]);

    expect(report.assets_cents).toBe(0);
    expect(report.entries[0]?.status).toBe('uncertain');
    expect(report.review_items.join(' ')).toContain('not exactly the claimed monetary amount');
  });

  it('creates a valid DOCX from the bounded renderer contract', async () => {
    const report = await createStructuredDocumentDocx({
      title: 'Evidence Summary',
      summary: 'Draft summary',
      sections: [
        {
          heading: 'Values',
          rows: [{ label: 'Balance', value: '$100.00', status: 'included', sources: ['statement.pdf p.1 l.2'] }],
        },
      ],
      notes: ['Review source evidence.'],
    });
    expect(report.subarray(0, 2).toString('binary')).toBe('PK');
    expect(report.length).toBeGreaterThan(1000);
  });

  it('requires approval before a document artifact can be written', async () => {
    const sandbox = makeStubPublicSandbox();
    const writeArtifact = jest.spyOn(sandbox, 'writeArtifact');
    const tools = new DocumentTools(sandbox, NOOP_AGENT_TRACING);
    const report = {
      title: 'Evidence Summary',
      summary: 'Draft summary',
      sections: [],
      notes: [],
    };

    await expect(tools.toolCallInfo({ name: CREATE_DOCUMENT_REPORT_TOOL_NAME, arguments: report })).resolves.toEqual(
      expect.objectContaining({ effect: 'edit', is_approval_required: true }),
    );
    await expect(tools.toolCallInfo({ name: SUMMARIZE_NET_WORTH_TOOL_NAME, arguments: {} })).resolves.toEqual(
      expect.objectContaining({ effect: 'edit', is_approval_required: true }),
    );
    await expect(tools.callTool({ name: CREATE_DOCUMENT_REPORT_TOOL_NAME, arguments: report })).resolves.toHaveProperty(
      'approvalRequired',
    );
    await tools.callTool(
      { name: CREATE_DOCUMENT_REPORT_TOOL_NAME, arguments: report },
      { status: 'deny', reason: 'Not now' },
    );

    expect(writeArtifact).not.toHaveBeenCalled();
  });

  it('stores each generated report under a unique safe artifact filename', async () => {
    const sandbox = makeStubPublicSandbox();
    const writeArtifact = jest.spyOn(sandbox, 'writeArtifact').mockImplementation(input =>
      Promise.resolve({
        filePath: `/tmp/tool-results/${input.fileName}`,
      }),
    );
    const tools = new DocumentTools(sandbox, NOOP_AGENT_TRACING);
    const report = {
      title: 'Evidence Summary',
      summary: 'Draft summary',
      sections: [],
      notes: [],
    };
    const approval = { status: 'allow', scope: 'once' } as const;

    await tools.callTool({ name: CREATE_DOCUMENT_REPORT_TOOL_NAME, arguments: report }, approval);
    await tools.callTool({ name: CREATE_DOCUMENT_REPORT_TOOL_NAME, arguments: report }, approval);

    const fileNames = writeArtifact.mock.calls.map(call => call[0].fileName);
    expect(fileNames).toHaveLength(2);
    expect(new Set(fileNames).size).toBe(2);
    expect(fileNames).toEqual([
      expect.stringMatching(
        /^document-report-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.docx$/,
      ),
      expect.stringMatching(
        /^document-report-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.docx$/,
      ),
    ]);
  });

  it('runs the synthetic 11-file mixed journey without checked-in binaries', async () => {
    const files = [
      ['checking.pdf', ['Checking balance $100.00']],
      ['savings.pdf', ['Savings balance $200.00']],
      ['brokerage.pdf', ['Brokerage value $300.00']],
      ['retirement.pdf', ['Retirement account value $400.00']],
      ['home.pdf', ['Home property value $500.00']],
      ['mortgage.pdf', ['Mortgage balance $50.00']],
      ['card.pdf', ['Credit card balance $25.00']],
      ['loan.pdf', ['Student loan balance $25.00']],
      ['bank-screenshot.png', ['Bank screenshot', 'Checking balance $100.00']],
      ['tax-screenshot.png', ['Tax screenshot', 'Savings balance $200.00']],
      ['retirement-screenshot.png', ['Retirement screenshot', 'Retirement account value $400.00']],
    ] as const;
    const result = await extractDocumentText({
      files: files.map(([filename]) => ({ filename, path: `uploads/${filename}` })),
      downloadFile: async path => {
        const filename = path.slice(path.lastIndexOf('/') + 1);
        const entry = files.find(candidate => candidate[0] === filename);
        return filename.endsWith('.pdf') ? makePdf([entry?.[1] ?? []]) : Buffer.from('synthetic screenshot');
      },
      runNativePdfText: async input => {
        const filename = input.filePath.slice(input.filePath.lastIndexOf('/') + 1);
        const entry = files.find(candidate => candidate[0] === filename);
        return { total_pages: 1, pages: [{ page_number: 1, text: (entry?.[1] ?? []).join('\n') }] };
      },
      runOcr: async input => {
        const filename = input.filename;
        const entry = files.find(candidate => candidate[0] === filename);
        return [{ page_number: 1, text: (entry?.[1] ?? []).join('\n') }];
      },
    });
    expect(result.documents).toHaveLength(11);
    const observations = result.documents.flatMap(document => {
      const line = document.pages[0]?.lines.find(candidate => /balance|value/.test(candidate.text));
      if (!line || document.pages[0] === undefined) {
        return [];
      }
      const amount = line.text.match(/\$(\d+)\.00/);
      const amountText = amount?.[0];
      const start = amountText === undefined ? -1 : line.text.indexOf(amountText);
      const source =
        start < 0 || amountText === undefined
          ? null
          : sourceForLine({
              document,
              page: 1,
              line: line.line_number,
              start,
              end: start + amountText.length,
            });
      if (!amount || source === null) {
        return [];
      }
      return [
        {
          key: line.text.replace(/\s*\$\d+\.00/, '').toLowerCase(),
          label: line.text,
          classification: /mortgage|card|loan/.test(line.text.toLowerCase()) ? 'liability' : 'asset',
          amount_cents: Number(amount[1]) * 100,
          source,
        } satisfies NetWorthObservationInput,
      ];
    });
    const report = summarizeNetWorth(result, observations);
    expect(report.draft).toBe(true);
    expect(report.assets_cents).toBe(80000);
    expect(report.liabilities_cents).toBe(10000);
    expect(report.net_worth_cents).toBe(70000);
    expect(report.review_items.join(' ')).toContain('conflicting cited observations');
    await createStructuredDocumentDocx(netWorthAsDocumentReport(report, 'Synthetic Net Worth'));
  });
});
