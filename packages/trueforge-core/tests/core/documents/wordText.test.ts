import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWordTextOutput, WORD_TEXT_SCRIPT } from '../../../src/documents/wordText';
import { hostCanReadWord, syntheticDocx, syntheticOdt, zipOf } from './syntheticWord';

const MARKER = 'AMAN_WORD_TEXT_test:';
const describeWithPython = hostCanReadWord() ? describe : describe.skip;

describeWithPython('the Word reader that runs in the sandbox', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'word-text-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the sandbox's own script on the bytes, the way the sandbox command does, and reads its answer. */
  function read({ bytes, limit = 100_000 }: { bytes: Buffer; limit?: number }): string {
    const path = join(dir, `file-${String(Math.random()).slice(2)}`);
    writeFileSync(path, bytes);
    const output = execFileSync('python3', ['-I', '-c', WORD_TEXT_SCRIPT, path, String(limit), MARKER], {
      encoding: 'utf8',
    });
    return parseWordTextOutput({ output, marker: MARKER });
  }

  it('reads an invented .docx: paragraphs in order, then the table row by row', async () => {
    const bytes = await syntheticDocx({
      paragraphs: ['Quarterly plan for the Rivera household', 'Budget review is on Friday.'],
      table: [
        ['Item', 'Amount'],
        ['Groceries', '420'],
      ],
    });
    expect(read({ bytes }).trimEnd().split('\n')).toEqual([
      'Quarterly plan for the Rivera household',
      'Budget review is on Friday.',
      'Item | Amount',
      'Groceries | 420',
    ]);
  });

  it('keeps English, Portuguese, Spanish and Japanese text intact', async () => {
    const paragraphs = [
      'The dentist moved the visit to 9 am.',
      'Reunião de planejamento: ação às 19h, não esqueça o bolo.',
      'Reunión de planificación: niño, año nuevo, ¿quién viene?',
      '誕生日パーティーは山田さんの家で行います。',
    ];
    const text = read({ bytes: await syntheticDocx({ paragraphs }) });
    expect(text.trimEnd().split('\n')).toEqual(paragraphs);
  });

  it('reads an invented .odt, with spaces, tabs and line breaks', () => {
    const bytes = syntheticOdt(
      '<text:h>Trip notes</text:h><text:p>Flight<text:s text:c="3"/>at 7<text:tab/>gate 4<text:line-break/>Lisboa, ação</text:p>',
    );
    expect(read({ bytes })).toBe('Trip notes\nFlight   at 7\tgate 4\nLisboa, ação\n');
  });

  it('cuts the text at the limit it is given', async () => {
    const bytes = await syntheticDocx({ paragraphs: ['abcdefghij'.repeat(20)] });
    expect(read({ bytes, limit: 50 }).trim()).toHaveLength(50);
  });

  it('gives a plain reason for a file that is not a Word document', () => {
    expect(() => read({ bytes: Buffer.from('just some text, not a zip') })).toThrow(
      'The file is not a valid Word or OpenDocument text file.',
    );
    expect(() => read({ bytes: zipOf({ 'readme.txt': 'hello' }) })).toThrow(
      'The file is not a Word or OpenDocument text document.',
    );
  });

  it('refuses a small file that unpacks to more than 100 MB, without reading it', () => {
    const bomb = zipOf({ 'word/document.xml': '<w:document/>' }, { repeatBytes: 101 * 1024 * 1024 });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(() => read({ bytes: bomb })).toThrow('The document is too large once unpacked, so it was not read.');
  });

  it('does not follow an external entity in an .odt', () => {
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'TOP-SECRET-VALUE');
    const bytes = zipOf({
      'content.xml': `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file://${secret}">]><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><text:p>before &x; after</text:p></office:document-content>`,
    });
    expect(read({ bytes })).not.toContain('TOP-SECRET-VALUE');
  });
});

describe('parseWordTextOutput', () => {
  it('returns the text after the marker line', () => {
    expect(parseWordTextOutput({ output: `noise\n${MARKER}OK\nline one\nline two\n`, marker: MARKER })).toBe(
      'line one\nline two\n',
    );
  });

  it('turns a reason code into a plain message, and an unknown one into a general one', () => {
    expect(() => parseWordTextOutput({ output: `${MARKER}ERR:TOO_BIG\n`, marker: MARKER })).toThrow('too large');
    expect(() => parseWordTextOutput({ output: `${MARKER}ERR:SOMETHING\n`, marker: MARKER })).toThrow(
      'The document could not be read.',
    );
  });

  it('says so when the reader gave no answer at all', () => {
    expect(() => parseWordTextOutput({ output: 'Traceback...', marker: MARKER })).toThrow('gave no answer');
  });
});
