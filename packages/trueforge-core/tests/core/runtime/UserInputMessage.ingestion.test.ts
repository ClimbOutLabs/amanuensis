import { EventType } from '../../../src/core/events/schema';
import {
  MAX_INGESTED_DOCUMENT_TEXT_CHARS,
  processAgentUserInput,
  type AgentInputUserMessage,
  type FileContentPart,
} from '../../../src/core/runtime/UserInputMessage';
import { syntheticBytesFor } from '../documents/syntheticFiles';
import '../harnessMocks';
import { makeStubPublicSandbox } from '../harnessMocks';

// Note: extractDocumentsFromSandbox is now called during turn execution, not in processAgentUserInput.
// The mocking is no longer needed here.

function dataUri(mime: string, text: string): string {
  return `data:${mime};base64,${Buffer.from(text).toString('base64')}`;
}

function messageFor(files: FileContentPart[]): AgentInputUserMessage {
  return { type: EventType.USER_MESSAGE, content: files };
}

function serializedTextParts(content: unknown): string[] {
  if (!Array.isArray(content)) {
    throw new Error('Expected multipart content');
  }
  return (content as { type: string; text?: string }[])
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map(part => part.text);
}

describe('processAgentUserInput document ingestion', () => {
  function makeSandboxWithUpload() {
    const sandbox = makeStubPublicSandbox();
    jest
      .spyOn(sandbox, 'uploadUserFile')
      .mockImplementation(input => Promise.resolve({ filePath: `/tmp/uploads/${input.fileName}` }));
    return sandbox;
  }

  function mockSnapshot(sandbox: ReturnType<typeof makeSandboxWithUpload>) {
    return jest.spyOn(sandbox, 'createDocumentSnapshot').mockImplementation(input =>
      Promise.resolve({
        filePath: input.filePath,
        content: syntheticBytesFor(input.filePath),
        verify: () => Promise.resolve(),
        cleanup: () => Promise.resolve(),
      }),
    );
  }

  it('stages a PDF for extraction', async () => {
    // Note: With the new architecture, extraction now happens in the turn loop (AgentThread.extractStagedDocuments),
    // not during processAgentUserInput. This test verifies that the PDF is staged for later extraction.
    const sandbox = makeSandboxWithUpload();
    mockSnapshot(sandbox);
    jest
      .spyOn(sandbox, 'runDocumentText')
      .mockResolvedValue({ total_pages: 1, pages: [{ page_number: 1, text: 'Q3 revenue was $4.2M.' }] });
    const runDocumentOcr = jest.spyOn(sandbox, 'runDocumentOcr');

    const msg = messageFor([{ type: 'file', name: 'report.pdf', data: dataUri('application/pdf', 'pdf-bytes') }]);
    const result = await processAgentUserInput(msg, sandbox);

    const staged = result.stagedDocuments;
    if (!staged) throw new Error('Expected stagedDocuments to be defined');
    expect(staged.length).toBe(1);
    const stagedFile = staged[0];
    if (!stagedFile) throw new Error('Expected a staged document at index 0');
    expect(stagedFile.filename).toBe('report.pdf');

    const texts = serializedTextParts(result.message.content);
    // Extracted text is no longer in processAgentUserInput result; it's added in the turn loop
    const ingested = texts.find(text => text.includes('Q3 revenue was $4.2M.'));
    expect(ingested).toBeUndefined();
    // But the upload announcement should still be there
    const announcement = texts.find(text => text.includes('Uploaded files'));
    expect(announcement).toBeDefined();
    expect(runDocumentOcr).not.toHaveBeenCalled();
  });

  it('stages a raster image for OCR extraction', async () => {
    // Note: With the new architecture, extraction happens in the turn loop, not in processAgentUserInput.
    const sandbox = makeSandboxWithUpload();
    mockSnapshot(sandbox);
    const runDocumentText = jest.spyOn(sandbox, 'runDocumentText');
    jest
      .spyOn(sandbox, 'runDocumentOcr')
      .mockResolvedValue([{ page_number: 1, text: 'Scanned receipt total: $18.40' }]);

    const msg = messageFor([{ type: 'file', name: 'receipt.png', data: dataUri('image/png', 'png-bytes') }]);
    const result = await processAgentUserInput(msg, sandbox);

    const staged = result.stagedDocuments;
    if (!staged) throw new Error('Expected stagedDocuments to be defined');
    expect(staged.length).toBe(1);
    const stagedFile = staged[0];
    if (!stagedFile) throw new Error('Expected a staged document at index 0');
    expect(stagedFile.filename).toBe('receipt.png');

    const texts = serializedTextParts(result.message.content);
    // Extracted text is no longer in processAgentUserInput result
    const ingested = texts.find(text => text.includes('Scanned receipt total: $18.40'));
    expect(ingested).toBeUndefined();
    expect(runDocumentText).not.toHaveBeenCalled();
  });

  it('stages an image and sends it as image_url without OCR when the model supports vision', async () => {
    const sandbox = makeSandboxWithUpload();
    mockSnapshot(sandbox);
    const runDocumentOcr = jest.spyOn(sandbox, 'runDocumentOcr');
    const runDocumentText = jest.spyOn(sandbox, 'runDocumentText');

    const imageData = dataUri('image/png', 'png-bytes');
    const msg = messageFor([{ type: 'file', name: 'receipt.png', data: imageData }]);
    const result = await processAgentUserInput(msg, sandbox, true);

    const content = result.message.content;
    if (!Array.isArray(content)) {
      throw new Error('Expected multipart content');
    }
    const imagePart = content.find(
      (part): part is { type: 'image_url'; image_url: { url: string } } =>
        (part as { type: string }).type === 'image_url',
    );
    expect(imagePart).toEqual({ type: 'image_url', image_url: { url: imageData } });

    const texts = serializedTextParts(content);
    expect(texts.some(text => text.includes('Uploaded files'))).toBe(true);
    // No OCR text for the vision image: the model already reads it via image_url, so it is not
    // staged for later extraction either.
    expect(texts.some(text => text.includes('Extracted text for receipt.png'))).toBe(false);
    expect(result.stagedDocuments).toBeUndefined();
    expect(runDocumentOcr).not.toHaveBeenCalled();
    expect(runDocumentText).not.toHaveBeenCalled();
  });

  it('emits no note at all for an unsupported extension', async () => {
    const sandbox = makeSandboxWithUpload();
    const createDocumentSnapshot = mockSnapshot(sandbox);

    const msg = messageFor([{ type: 'file', name: 'archive.zip', data: dataUri('application/zip', 'zip-bytes') }]);
    const result = await processAgentUserInput(msg, sandbox);

    const texts = serializedTextParts(result.message.content);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Uploaded files');
    expect(createDocumentSnapshot).not.toHaveBeenCalled();
  });

  it('stages only supported files for extraction, excluding unsupported types', async () => {
    // Note: Extraction is now deferred to the turn loop, so extractDocumentsFromSandbox is not called here.
    // This test verifies that only supported files are included in stagedDocuments.
    const sandbox = makeSandboxWithUpload();
    mockSnapshot(sandbox);
    jest
      .spyOn(sandbox, 'runDocumentText')
      .mockResolvedValue({ total_pages: 1, pages: [{ page_number: 1, text: 'body text' }] });

    const msg = messageFor([
      { type: 'file', name: 'first.pdf', data: dataUri('application/pdf', 'pdf-bytes-1') },
      { type: 'file', name: 'second.pdf', data: dataUri('application/pdf', 'pdf-bytes-2') },
      { type: 'file', name: 'notes.txt', data: dataUri('text/plain', 'irrelevant') },
    ]);
    const result = await processAgentUserInput(msg, sandbox);

    const staged = result.stagedDocuments;
    if (!staged) throw new Error('Expected stagedDocuments to be defined');
    expect(staged).toHaveLength(2);
    const [firstStaged, secondStaged] = staged;
    if (!firstStaged || !secondStaged) throw new Error('Expected two staged documents');
    expect(firstStaged.filename).toBe('first.pdf');
    expect(secondStaged.filename).toBe('second.pdf');

    const texts = serializedTextParts(result.message.content);
    const announcement = texts.find(text => text.includes('Uploaded files'));
    expect(announcement).toBeDefined();
    expect(announcement).toContain('notes.txt');
  });

  it('stages all supported files for extraction with shared budget', async () => {
    // Note: Byte budget is now managed in the turn loop during extraction.
    // This test verifies that all supported files are staged.
    const sandbox = makeSandboxWithUpload();
    jest.spyOn(sandbox, 'createDocumentSnapshot').mockImplementation(input =>
      Promise.resolve({
        filePath: input.filePath,
        content: Buffer.alloc(80_000_000),
        verify: () => Promise.resolve(),
        cleanup: () => Promise.resolve(),
      }),
    );
    jest
      .spyOn(sandbox, 'runDocumentText')
      .mockResolvedValue({ total_pages: 1, pages: [{ page_number: 1, text: 'body text' }] });

    const msg = messageFor([
      { type: 'file', name: 'first.pdf', data: dataUri('application/pdf', 'pdf-bytes-1') },
      { type: 'file', name: 'second.pdf', data: dataUri('application/pdf', 'pdf-bytes-2') },
    ]);
    const result = await processAgentUserInput(msg, sandbox);

    expect(result.stagedDocuments).toBeDefined();
    expect(result.stagedDocuments!).toHaveLength(2);
    // Budget sharing is verified during the actual extraction in the turn loop
  });

  it('stages a large PDF for extraction with truncation', async () => {
    // Note: Truncation happens during extraction in the turn loop, not in processAgentUserInput.
    const sandbox = makeSandboxWithUpload();
    mockSnapshot(sandbox);
    const longText = 'A'.repeat(MAX_INGESTED_DOCUMENT_TEXT_CHARS + 500);
    jest
      .spyOn(sandbox, 'runDocumentText')
      .mockResolvedValue({ total_pages: 1, pages: [{ page_number: 1, text: longText }] });

    const msg = messageFor([{ type: 'file', name: 'long.pdf', data: dataUri('application/pdf', 'pdf-bytes') }]);
    const result = await processAgentUserInput(msg, sandbox);

    const staged = result.stagedDocuments;
    if (!staged) throw new Error('Expected stagedDocuments to be defined');
    expect(staged.length).toBe(1);
    const stagedFile = staged[0];
    if (!stagedFile) throw new Error('Expected a staged document at index 0');
    expect(stagedFile.filename).toBe('long.pdf');

    // Extracted text is now handled during extraction in the turn loop
    const texts = serializedTextParts(result.message.content);
    expect(texts.some(text => text.includes('long.pdf') && text.includes('AAAA'))).toBe(false);
  });

  it('stages a PDF with emoji without extracting yet', async () => {
    // Note: Emoji/surrogate pair handling now occurs during extraction in the turn loop.
    const sandbox = makeSandboxWithUpload();
    mockSnapshot(sandbox);
    const prefix = 'A'.repeat(MAX_INGESTED_DOCUMENT_TEXT_CHARS - 1);
    const surrogatePair = '\u{1F600}';
    const highSurrogate = surrogatePair.charCodeAt(0);
    expect(highSurrogate).toBeGreaterThanOrEqual(0xd800);
    expect(highSurrogate).toBeLessThanOrEqual(0xdbff);
    const longText = `${prefix}${surrogatePair}${'B'.repeat(10)}`;
    jest
      .spyOn(sandbox, 'runDocumentText')
      .mockResolvedValue({ total_pages: 1, pages: [{ page_number: 1, text: longText }] });

    const msg = messageFor([{ type: 'file', name: 'emoji.pdf', data: dataUri('application/pdf', 'pdf-bytes') }]);
    const result = await processAgentUserInput(msg, sandbox);

    const staged = result.stagedDocuments;
    if (!staged) throw new Error('Expected stagedDocuments to be defined');
    const stagedFile = staged[0];
    if (!stagedFile) throw new Error('Expected a staged document at index 0');
    expect(stagedFile.filename).toBe('emoji.pdf');
  });

  it('stages a PDF for later extraction even if sandbox operations might fail', async () => {
    // Note: Extraction failures are now handled during the turn loop.
    // This test verifies that the file is still staged even if sandbox operations fail later.
    const sandbox = makeSandboxWithUpload();
    jest.spyOn(sandbox, 'createDocumentSnapshot').mockRejectedValue(new Error('snapshot changed during read'));

    const msg = messageFor([{ type: 'file', name: 'broken.pdf', data: dataUri('application/pdf', 'pdf-bytes') }]);
    const result = await processAgentUserInput(msg, sandbox);

    const staged = result.stagedDocuments;
    if (!staged) throw new Error('Expected stagedDocuments to be defined');
    const stagedFile = staged[0];
    if (!stagedFile) throw new Error('Expected a staged document at index 0');
    expect(stagedFile.filename).toBe('broken.pdf');

    // The error message will be handled during extraction in the turn loop
    const texts = serializedTextParts(result.message.content);
    const errorNote = texts.find(text => text.includes('broken.pdf') && text.includes('snapshot changed during read'));
    expect(errorNote).toBeUndefined(); // No error yet; it happens during extraction
  });

  it('stages documents for later extraction when the signal is aborted', async () => {
    // Note: With the new architecture, extraction happens in the turn loop, not in processAgentUserInput.
    // The signal is not used here anymore; abort handling now happens in AgentThread.extractStagedDocuments().
    const sandbox = makeSandboxWithUpload();
    mockSnapshot(sandbox);
    jest
      .spyOn(sandbox, 'runDocumentText')
      .mockResolvedValue({ total_pages: 1, pages: [{ page_number: 1, text: 'text' }] });

    const msg = messageFor([{ type: 'file', name: 'report.pdf', data: dataUri('application/pdf', 'pdf-bytes') }]);
    const result = await processAgentUserInput(msg, sandbox);

    const staged = result.stagedDocuments;
    if (!staged) throw new Error('Expected stagedDocuments to be defined');
    expect(staged.length).toBe(1);
    const stagedFile = staged[0];
    if (!stagedFile) throw new Error('Expected a staged document at index 0');
    expect(stagedFile.filename).toBe('report.pdf');

    const texts = serializedTextParts(result.message.content);
    expect(texts.some(text => text.includes('Uploaded files'))).toBe(true);
    // Extracted text is no longer in processAgentUserInput result; it's added in the turn loop
    expect(texts.some(text => text.includes('text') && text.includes('report.pdf') && text.includes('Method'))).toBe(
      false,
    );
  });

  it('stages multiple documents for later extraction', async () => {
    // Note: With the new architecture, extraction happens in the turn loop, not in processAgentUserInput.
    // Multiple supported documents are staged and will be extracted together in the turn loop.
    const sandbox = makeSandboxWithUpload();
    mockSnapshot(sandbox);
    jest
      .spyOn(sandbox, 'runDocumentText')
      .mockResolvedValue({ total_pages: 1, pages: [{ page_number: 1, text: 'text' }] });

    const msg = messageFor([
      { type: 'file', name: 'first.pdf', data: dataUri('application/pdf', 'pdf-bytes-1') },
      { type: 'file', name: 'second.pdf', data: dataUri('application/pdf', 'pdf-bytes-2') },
    ]);
    const result = await processAgentUserInput(msg, sandbox);

    const staged = result.stagedDocuments;
    if (!staged) throw new Error('Expected stagedDocuments to be defined');
    expect(staged.length).toBe(2);
    const [firstStaged, secondStaged] = staged;
    if (!firstStaged || !secondStaged) throw new Error('Expected two staged documents');
    expect(firstStaged.filename).toBe('first.pdf');
    expect(secondStaged.filename).toBe('second.pdf');

    const texts = serializedTextParts(result.message.content);
    expect(texts.some(text => text.includes('Uploaded files'))).toBe(true);
    // Extracted text is no longer in processAgentUserInput result
    expect(texts.some(text => text.includes('text') && text.includes('first.pdf') && text.includes('Method'))).toBe(
      false,
    );
  });

  it('stages a PDF for later extraction and sends an image as image_url when modelSupportsVision is true', async () => {
    const sandbox = makeSandboxWithUpload();
    mockSnapshot(sandbox);
    const runDocumentOcr = jest.spyOn(sandbox, 'runDocumentOcr');
    const runDocumentText = jest.spyOn(sandbox, 'runDocumentText');

    const pdfData = dataUri('application/pdf', 'pdf-bytes');
    const imageData = dataUri('image/png', 'png-bytes');
    const msg = messageFor([
      { type: 'file', name: 'document.pdf', data: pdfData },
      { type: 'file', name: 'screenshot.png', data: imageData },
    ]);
    const result = await processAgentUserInput(msg, sandbox, true);

    const content = result.message.content;
    if (!Array.isArray(content)) {
      throw new Error('Expected multipart content');
    }

    // Verify image is sent as image_url
    const imagePart = content.find(
      (part): part is { type: 'image_url'; image_url: { url: string } } =>
        (part as { type: string }).type === 'image_url',
    );
    expect(imagePart).toEqual({ type: 'image_url', image_url: { url: imageData } });

    // Verify the PDF is staged for later extraction in the turn loop, not extracted here.
    const staged = result.stagedDocuments;
    if (!staged) throw new Error('Expected stagedDocuments to be defined');
    expect(staged).toHaveLength(1);
    const stagedFile = staged[0];
    if (!stagedFile) throw new Error('Expected a staged document at index 0');
    expect(stagedFile.filename).toBe('document.pdf');

    // The vision image is not staged for extraction: the model already reads it via image_url.
    expect(staged.some(file => file.filename === 'screenshot.png')).toBe(false);
    expect(runDocumentOcr).not.toHaveBeenCalled();
    expect(runDocumentText).not.toHaveBeenCalled();

    // Verify upload announcement is present
    const texts = serializedTextParts(content);
    expect(texts.some(text => text.includes('Uploaded files'))).toBe(true);

    // Verify parts order: text parts come first, then image_url
    const textPartIndices = content
      .map((part, i) => ((part as { type: string }).type === 'text' ? i : -1))
      .filter(i => i !== -1);
    const imagePartIndex = content.findIndex(part => (part as { type: string }).type === 'image_url');
    expect(textPartIndices.length).toBeGreaterThan(0);
    expect(imagePartIndex).toBeGreaterThan(Math.max(...textPartIndices));
  });
});

// Note: Document ingestion progress events are no longer emitted from processAgentUserInput.
// They are now emitted from AgentThread.extractStagedDocuments() in the turn loop,
// so they stream live without polling. See: AgentThread.execute() pre-model step.
// TODO: Add tests for AgentThread.extractStagedDocuments() to verify live streaming behavior.
