import { createHash } from 'node:crypto';
import {
  CREATE_DOCUMENT_REPORT_TOOL_NAME,
  DocumentTools,
  EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
  SUMMARIZE_NET_WORTH_TOOL_NAME,
} from '../../../src/core/capabilities/builtins/DocumentTools';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import {
  createDocumentExtractionBudget,
  createSessionDocumentExtractionBudget,
  extractDocumentText,
  isSupportedDocumentExtension,
  MAX_BYTES_PER_DOCUMENT,
  MAX_CHARS_PER_DOCUMENT,
  MAX_DOCUMENT_FILES,
  MAX_OCR_PAGES_PER_CALL,
  MAX_TOTAL_DOCUMENT_BYTES,
  SESSION_BUDGET_SCALE,
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
import { syntheticPdf, syntheticPng } from './syntheticFiles';

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

const unusedWordText = (): Promise<{ text: string }> => Promise.reject(new Error('no Word file in this test'));

describe('local document pipeline', () => {
  it('preserves native multiline PDF text and OCRs only the empty mixed-PDF page', async () => {
    const pdf = makePdf([['Statement date: 2026-08-01', 'Checking account balance: $100.00'], []]);
    const ocrCalls: { pages: readonly number[] | undefined; kind: string }[] = [];
    const result = await extractDocumentText({
      files: [{ filename: 'mixed.pdf', path: 'uploads/mixed.pdf' }],
      onFileProgress: undefined,
      budget: undefined,
      pageRange: undefined,
      downloadFile: async () => pdf,
      runWordText: unusedWordText,
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
      onFileProgress: undefined,
      budget: undefined,
      pageRange: undefined,
      downloadFile: async () => syntheticPng(),
      runWordText: unusedWordText,
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
      onFileProgress: undefined,
      budget: undefined,
      pageRange: undefined,
      downloadFile: async () => syntheticPng(),
      runWordText: unusedWordText,
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
      onFileProgress: undefined,
      budget: undefined,
      pageRange: undefined,
      downloadFile: async () => syntheticPng(),
      runWordText: unusedWordText,
      runNativePdfText: async () => ({ total_pages: 0, pages: [] }),
      runOcr: async () => [{ page_number: 1, text: 'x'.repeat(MAX_CHARS_PER_DOCUMENT + 100) }],
    });
    expect(result.documents).toHaveLength(MAX_DOCUMENT_FILES + 1);
    expect(result.documents[MAX_DOCUMENT_FILES]?.issue).toContain('maximum');
    expect(result.documents[0]?.pages[0]?.lines[0]?.text.length).toBeLessThanOrEqual(MAX_CHARS_PER_DOCUMENT);
  });

  it('bounds materialized snapshots by the session aggregate byte limit', async () => {
    const sandbox = makeStubPublicSandbox();
    const verify = jest.fn(() => Promise.resolve());
    const cleanup = jest.fn(() => Promise.resolve());
    const snapshotLimits: (number | undefined)[] = [];
    jest.spyOn(sandbox, 'createDocumentSnapshot').mockImplementation(input => {
      snapshotLimits.push(input.maxBytes);
      // Honor the requested cap so the byte accounting is exact.
      return Promise.resolve({ filePath: input.filePath, content: Buffer.alloc(input.maxBytes ?? 0), verify, cleanup });
    });
    const tools = new DocumentTools(sandbox, NOOP_AGENT_TRACING);
    // The tool path carries a session-scale aggregate budget (10x the
    // per-call caps): 40 full-size snapshots exactly exhaust it. The tool
    // schema caps each call at 32 files, so exhaustion takes three calls
    // sharing one session budget; the 41st file is refused before any
    // bytes are materialized.
    const aggregateFileCount = (MAX_TOTAL_DOCUMENT_BYTES * SESSION_BUDGET_SCALE) / MAX_BYTES_PER_DOCUMENT;
    const filePaths = (range: { start: number; count: number }): string[] =>
      Array.from({ length: range.count }, (_, index) => `/tmp/uploads/document-${String(range.start + index)}.txt`);

    await tools.callTool({
      name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
      arguments: { file_paths: filePaths({ start: 0, count: 32 }) },
    });
    await tools.callTool({
      name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
      arguments: { file_paths: filePaths({ start: 32, count: 8 }) },
    });
    const refused = await tools.callTool({
      name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
      arguments: { file_paths: filePaths({ start: 40, count: 1 }) },
    });

    expect(snapshotLimits).toEqual(Array.from({ length: aggregateFileCount }, () => MAX_BYTES_PER_DOCUMENT));
    expect(verify).toHaveBeenCalledTimes(aggregateFileCount);
    expect(cleanup).toHaveBeenCalledTimes(aggregateFileCount);
    expect(JSON.stringify(refused)).toContain('aggregate byte limit');
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

  it('renders a full-mode report through the tool and guides compact overflows to full mode', async () => {
    const sandbox = makeStubPublicSandbox();
    const written: Buffer[] = [];
    jest.spyOn(sandbox, 'writeArtifact').mockImplementation(input => {
      written.push(input.content);
      return Promise.resolve({ filePath: `/tmp/tool-results/${input.fileName}` });
    });
    const tools = new DocumentTools(sandbox, NOOP_AGENT_TRACING);
    const sections = ['Income', 'Expenses', 'Accounts', 'Tax'].map((heading, sectionIndex) => ({
      heading,
      rows: Array.from({ length: 52 }, (_, rowIndex) => ({
        label: `Item ${String(sectionIndex * 52 + rowIndex)}`,
        value: '$1.00',
        status: 'included' as const,
        sources: ['statement.pdf p.1 l.1'],
      })),
    }));
    const report = {
      title: 'Synthetic Financial Plan',
      summary: '208 rows across 4 sections.',
      sections,
      notes: ['Synthetic data only.'],
    };
    const approval = { status: 'allow', scope: 'once' } as const;

    // Full mode renders the whole 208-row report.
    const fullResult = await tools.callTool(
      { name: CREATE_DOCUMENT_REPORT_TOOL_NAME, arguments: { ...report, mode: 'full' } },
      approval,
    );
    expect(written).toHaveLength(1);
    expect(written[0]?.subarray(0, 2).toString('binary')).toBe('PK');
    if (!('result' in fullResult)) {
      throw new Error('expected a resolved tool result, got an approval request');
    }
    expect(fullResult.result.isError ?? false).toBe(false);

    // The same report in default compact mode fails with a structured,
    // actionable error instead of a text blob.
    const compactResult = await tools.callTool({ name: CREATE_DOCUMENT_REPORT_TOOL_NAME, arguments: report }, approval);
    expect(compactResult).toMatchObject({ result: { isError: true } });
    const text =
      'result' in compactResult && Array.isArray(compactResult.result.content)
        ? compactResult.result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
        : '';
    const payload = JSON.parse(text) as { error?: string };
    expect(payload.error).toMatch(/compact mode limits/);
    expect(payload.error).toMatch(/Use mode "full" for longer reports/);
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
      onFileProgress: undefined,
      budget: undefined,
      pageRange: undefined,
      downloadFile: async path => {
        const filename = path.slice(path.lastIndexOf('/') + 1);
        const entry = files.find(candidate => candidate[0] === filename);
        return filename.endsWith('.pdf') ? makePdf([entry?.[1] ?? []]) : syntheticPng();
      },
      runWordText: unusedWordText,
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

describe('document page-range extraction', () => {
  function pdfInput(overrides: {
    pageRange?: { page_start: number; page_end: number };
    budget?: ReturnType<typeof createDocumentExtractionBudget>;
    totalPages?: number;
    nativePages?: { [page: number]: string };
  }): Parameters<typeof extractDocumentText>[0] {
    const totalPages = overrides.totalPages ?? 500;
    return {
      files: [{ filename: 'lease.pdf', path: 'uploads/lease.pdf' }],
      onFileProgress: undefined,
      budget: overrides.budget,
      pageRange: overrides.pageRange,
      downloadFile: async () => syntheticPdf(),
      runWordText: unusedWordText,
      runNativePdfText: async input => {
        const pages = Object.entries(overrides.nativePages ?? {}).map(([page, text]) => ({
          page_number: Number(page),
          text,
        }));
        expect(input.firstPage).toBeGreaterThanOrEqual(1);
        return { total_pages: totalPages, pages };
      },
      runOcr: async () => [],
    };
  }

  it('starts native extraction at the absolute page and never re-processes earlier pages', async () => {
    const nativeCalls: { firstPage: number; maxPages: number }[] = [];
    const input = pdfInput({
      pageRange: { page_start: 6, page_end: 10 },
      nativePages: { 6: 'Page six', 7: 'Page seven', 8: 'Page eight', 9: 'Page nine', 10: 'Page ten' },
    });
    const originalNative = input.runNativePdfText;
    input.runNativePdfText = async call => {
      nativeCalls.push({ firstPage: call.firstPage, maxPages: call.maxPages });
      return originalNative(call);
    };
    const result = await extractDocumentText(input);

    expect(nativeCalls).toEqual([{ firstPage: 6, maxPages: 5 }]);
    const document = result.documents[0];
    expect(document?.pages.map(page => page.page_number)).toEqual([6, 7, 8, 9, 10]);
    expect(document?.issue).toContain('Read pages 6-10 of 500 total');
    expect(document?.issue).toContain('page_start=11');
  });

  it('keeps the true total page count on a range read', async () => {
    const result = await extractDocumentText(
      pdfInput({ pageRange: { page_start: 1, page_end: 3 }, nativePages: { 1: 'a', 2: 'b', 3: 'c' }, totalPages: 42 }),
    );
    expect(result.documents[0]?.issue).toContain('of 42 total');
    expect(result.documents[0]?.issue).toContain('page_start=4');
  });

  it('rejects a page_start beyond the end of the document', async () => {
    const result = await extractDocumentText(
      pdfInput({ pageRange: { page_start: 600, page_end: 610 }, nativePages: {}, totalPages: 500 }),
    );
    expect(result.documents[0]?.issue).toContain('page_start 600 is beyond the end of lease.pdf (500 pages)');
    expect(result.documents[0]?.pages).toHaveLength(0);
  });

  it('fails loudly and helpfully on old Word and RTF files it cannot read', async () => {
    const input = pdfInput({});
    input.files = [{ filename: 'contract.doc', path: 'uploads/contract.doc' }];
    const result = await extractDocumentText(input);
    expect(result.documents[0]?.issue).toBe(
      "I can't read contract.doc yet: .doc files are not supported. Convert it to PDF and I'll read all of it.",
    );
    expect(result.documents[0]?.pages).toHaveLength(0);
  });

  describe('Word documents', () => {
    const zipHeader = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]);

    function wordInput({ filename, bytes, text }: { filename: string; bytes: Buffer; text: string }) {
      const reads: string[] = [];
      const input = pdfInput({});
      input.files = [{ filename, path: `uploads/${filename}` }];
      input.downloadFile = async () => bytes;
      input.runWordText = async call => {
        reads.push(call.filePath);
        return { text };
      };
      return { input, reads };
    }

    it('accepts .docx and .odt as readable attachments, in any letter case', () => {
      for (const name of ['plan.docx', 'PLAN.DOCX', 'notes.odt', 'scan.pdf', 'photo.png']) {
        expect(isSupportedDocumentExtension(name)).toBe(true);
      }
      for (const name of ['plan.doc', 'plan.rtf', 'sheet.xlsx', 'notes.txt']) {
        expect(isSupportedDocumentExtension(name)).toBe(false);
      }
    });

    it.each(['plan.docx', 'notes.odt'])('reads %s as one text page with line numbers', async filename => {
      const { input, reads } = wordInput({ filename, bytes: zipHeader, text: 'Reunião às 19h\n\nSegunda linha\n' });
      const result = await extractDocumentText(input);
      expect(reads).toEqual([`uploads/${filename}`]);
      expect(result.documents[0]).toMatchObject({
        extraction_mode: 'text',
        issue: null,
        pages: [
          {
            page_number: 1,
            extraction_mode: 'text',
            lines: [
              { line_number: 1, text: 'Reunião às 19h' },
              { line_number: 3, text: 'Segunda linha' },
            ],
          },
        ],
      });
    });

    it('does not send a file to the reader unless it is a zip', async () => {
      const { input, reads } = wordInput({ filename: 'fake.docx', bytes: Buffer.from('plain text'), text: 'x' });
      const result = await extractDocumentText(input);
      expect(reads).toEqual([]);
      expect(result.documents[0]?.issue).toBe('fake.docx is not a valid Word document, so it cannot be read.');
    });

    it('says plainly when the document holds no text', async () => {
      const { input } = wordInput({ filename: 'pictures.docx', bytes: zipHeader, text: '\n  \n' });
      const result = await extractDocumentText(input);
      expect(result.documents[0]?.pages).toHaveLength(0);
      expect(result.documents[0]?.issue).toBe('pictures.docx has no text to read. It may hold only pictures.');
    });

    it('keeps the size cap: a Word file over 25 MB is skipped unread', async () => {
      const { input, reads } = wordInput({
        filename: 'huge.docx',
        bytes: Buffer.alloc(MAX_BYTES_PER_DOCUMENT + 1),
        text: 'x',
      });
      const result = await extractDocumentText(input);
      expect(reads).toEqual([]);
      expect(result.documents[0]?.issue).toBe('Skipped huge.docx: document byte limit exceeded.');
    });

    it('rejects a page range, which only a PDF has', async () => {
      const { input } = wordInput({ filename: 'plan.docx', bytes: zipHeader, text: 'x' });
      input.pageRange = { page_start: 2, page_end: 3 };
      const result = await extractDocumentText(input);
      expect(result.documents[0]?.issue).toBe('page_start/page_end apply to PDF files only; plan.docx is not a PDF.');
    });

    it('says only the head is shown when the text passes the per-document character cap', async () => {
      const { input } = wordInput({
        filename: 'long.docx',
        bytes: zipHeader,
        text: 'a'.repeat(MAX_CHARS_PER_DOCUMENT + 500),
      });
      const result = await extractDocumentText(input);
      expect(result.documents[0]?.issue).toContain('only its head is shown');
    });

    it('names the supported types when a file is none of them', async () => {
      const input = pdfInput({});
      input.files = [{ filename: 'sheet.xlsx', path: 'uploads/sheet.xlsx' }];
      const result = await extractDocumentText(input);
      expect(result.documents[0]?.issue).toBe(
        'Unsupported document type for sheet.xlsx; expected a PDF, a Word document (.docx or .odt) or a raster image.',
      );
    });
  });

  it('OCRs empty native pages with absolute page numbers (401-405)', async () => {
    const ocrCalls: { pages: readonly number[] | undefined }[] = [];
    const input = pdfInput({
      pageRange: { page_start: 401, page_end: 405 },
      nativePages: { 401: '', 402: '', 403: '', 404: '', 405: '' },
    });
    input.runOcr = async call => {
      ocrCalls.push({ pages: call.pages });
      return (call.pages ?? []).map(page_number => ({ page_number, text: `scanned page ${String(page_number)}` }));
    };
    const result = await extractDocumentText(input);

    expect(ocrCalls).toEqual([{ pages: [401, 402, 403, 404, 405] }]);
    const document = result.documents[0];
    expect(document?.pages.map(page => page.page_number)).toEqual([401, 402, 403, 404, 405]);
    expect(document?.extraction_mode).toBe('mixed');
    expect(document?.pages[0]?.lines.map(line => line.text)).toEqual(['scanned page 401']);
  });

  it('rejects page ranges for images', async () => {
    const input = pdfInput({ pageRange: { page_start: 2, page_end: 3 } });
    input.files = [{ filename: 'photo.png', path: 'uploads/photo.png' }];
    const result = await extractDocumentText(input);
    expect(result.documents[0]?.issue).toContain('page_start/page_end apply to PDF files only');
  });

  it('drops a page that does not fit whole and names the exact next page_start', async () => {
    // A fresh per-call budget: the cut page is continuable, never half-shown.
    const budget = createDocumentExtractionBudget();
    budget.remainingCharacters = 150;
    const result = await extractDocumentText(
      pdfInput({
        budget,
        totalPages: 3,
        nativePages: { 1: 'x'.repeat(100), 2: 'y'.repeat(100), 3: 'z'.repeat(100) },
      }),
    );
    const document = result.documents[0];
    expect(document?.pages.map(page => page.page_number)).toEqual([1]);
    // Page 2 is not shown partially: its text is absent from the output.
    expect(JSON.stringify(document?.pages)).not.toContain('y');
    expect(document?.issue).toContain('page_start=2');
    expect(document?.issue).toContain('a fresh call continues with what remains');
  });

  it('reports a session dead end honestly when the aggregate budget is exhausted', async () => {
    const budget = createSessionDocumentExtractionBudget();
    budget.remainingCharacters = 100;
    const result = await extractDocumentText(
      pdfInput({
        budget,
        totalPages: 3,
        nativePages: { 1: 'x'.repeat(100), 2: 'y'.repeat(100), 3: 'z'.repeat(100) },
      }),
    );
    const document = result.documents[0];
    expect(document?.pages.map(page => page.page_number)).toEqual([1]);
    expect(document?.issue).toContain('aggregate page/character budget is exhausted');
    expect(document?.issue).toContain('re-running cannot show more');
    expect(document?.issue).not.toContain('page_start=');
  });
});

describe('files are checked by their bytes before OCR', () => {
  async function extractOne({
    filename,
    bytes,
    totalPages = 1,
  }: {
    filename: string;
    bytes: Buffer;
    totalPages?: number;
  }) {
    const ocrCalls: { pages: readonly number[] | undefined; maxPages: number }[] = [];
    const result = await extractDocumentText({
      files: [{ filename, path: `uploads/${filename}` }],
      onFileProgress: undefined,
      budget: undefined,
      pageRange: undefined,
      downloadFile: async () => bytes,
      runWordText: unusedWordText,
      runNativePdfText: async () => ({ total_pages: totalPages, pages: [] }),
      runOcr: async input => {
        ocrCalls.push({ pages: input.pages, maxPages: input.maxPages });
        return (input.pages ?? [1]).map(page_number => ({ page_number, text: `page ${String(page_number)}` }));
      },
    });
    return { document: result.documents[0], ocrCalls };
  }

  it('does not run PDF tools on a file that is not a PDF', async () => {
    const { document } = await extractOne({ filename: 'invoice.pdf', bytes: Buffer.from('MZ not a pdf') });
    expect(document?.issue).toBe('invoice.pdf is not a valid PDF, so it cannot be read.');
  });

  it('does not run OCR on bytes that are not an image of the type the name says', async () => {
    const notAnImage = await extractOne({ filename: 'scan.png', bytes: syntheticPdf() });
    expect(notAnImage.document?.issue).toContain('is not a valid image of the type its name says');
    expect(notAnImage.ocrCalls).toEqual([]);
    const wrongType = await extractOne({ filename: 'scan.jpg', bytes: syntheticPng() });
    expect(wrongType.document?.issue).toContain('is not a valid image of the type its name says');
  });

  it('does not run OCR on an image with too many pixels', async () => {
    const { document, ocrCalls } = await extractOne({
      filename: 'huge.png',
      bytes: syntheticPng({ width: 20_000, height: 20_000 }),
    });
    expect(document?.issue).toContain('is too large to read (20000 by 20000 pixels)');
    expect(ocrCalls).toEqual([]);
  });

  it('reads a normal image', async () => {
    const { document, ocrCalls } = await extractOne({ filename: 'ok.png', bytes: syntheticPng() });
    expect(document?.pages[0]?.lines[0]?.text).toBe('page 1');
    expect(ocrCalls).toHaveLength(1);
  });

  it('reads at most 20 scanned pages per call and names where the rest starts', async () => {
    const { document, ocrCalls } = await extractOne({ filename: 'scan.pdf', bytes: syntheticPdf(), totalPages: 100 });
    expect(ocrCalls).toHaveLength(1);
    expect(ocrCalls[0]?.pages).toEqual(Array.from({ length: MAX_OCR_PAGES_PER_CALL }, (_, index) => index + 1));
    expect(document?.issue).toContain('OCR read the first 20 scanned pages');
    expect(document?.issue).toContain('page_start=21');
  });
});
