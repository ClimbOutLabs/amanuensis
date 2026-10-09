import { RunCodeInputSchema, RunCodeResultSchema } from '../../../../src/core/sandbox/driver/RunCodeSchemas';

describe('RunCodeInputSchema', () => {
  const valid = { language: 'python', code: 'print("hi")' };

  it('accepts a minimal valid input and defaults files_in to []', () => {
    const parsed = RunCodeInputSchema.parse(valid);
    expect(parsed.language).toBe('python');
    expect(parsed.files_in).toEqual([]);
    expect(parsed.timeout_seconds).toBeUndefined();
  });

  it('accepts node and an explicit timeout', () => {
    const parsed = RunCodeInputSchema.parse({ language: 'node', code: 'console.log(1)', timeout_seconds: 30 });
    expect(parsed.language).toBe('node');
    expect(parsed.timeout_seconds).toBe(30);
  });

  it('rejects unknown languages', () => {
    expect(() => RunCodeInputSchema.parse({ ...valid, language: 'ruby' })).toThrow();
    expect(() => RunCodeInputSchema.parse({ ...valid, language: 'bash' })).toThrow();
  });

  it('rejects empty code and code over the 512 KiB cap', () => {
    expect(() => RunCodeInputSchema.parse({ ...valid, code: '' })).toThrow();
    expect(() => RunCodeInputSchema.parse({ ...valid, code: 'x'.repeat(513 * 1024) })).toThrow();
    expect(() => RunCodeInputSchema.parse({ ...valid, code: 'x'.repeat(512 * 1024) })).not.toThrow();
  });

  it('rejects files_in entries that are not basenames', () => {
    const file = (name: string) => ({ name, content_base64: Buffer.from('x').toString('base64') });
    for (const bad of ['a/b.csv', '../evil', '..', '.', 'sub\\x.csv', '']) {
      expect(() => RunCodeInputSchema.parse({ ...valid, files_in: [file(bad)] })).toThrow();
    }
    expect(() => RunCodeInputSchema.parse({ ...valid, files_in: [file('data.csv'), file('notes.txt')] })).not.toThrow();
  });

  it('rejects more than 32 files_in entries', () => {
    const file = (i: number) => ({ name: `f${String(i)}.csv`, content_base64: Buffer.from('x').toString('base64') });
    const files = Array.from({ length: 33 }, (_, i) => file(i));
    expect(() => RunCodeInputSchema.parse({ ...valid, files_in: files })).toThrow();
  });

  it('rejects out-of-range timeout_seconds', () => {
    for (const t of [0, -5, 601, 1.5]) {
      expect(() => RunCodeInputSchema.parse({ ...valid, timeout_seconds: t })).toThrow();
    }
    expect(() => RunCodeInputSchema.parse({ ...valid, timeout_seconds: 600 })).not.toThrow();
  });
});

describe('RunCodeResultSchema', () => {
  const base = {
    exit_code: 0,
    stdout: 'hi',
    stderr: '',
    stdout_truncated: false,
    stderr_truncated: false,
    files_out: [],
    harvest_warnings: [],
  };

  it('accepts an ok result', () => {
    const parsed = RunCodeResultSchema.parse({ status: 'ok', ...base });
    expect(parsed.status).toBe('ok');
  });

  it('accepts a failed result with a known error code', () => {
    const parsed = RunCodeResultSchema.parse({
      status: 'failed',
      error_code: 'timeout',
      error: 'too slow',
      ...base,
    });
    expect(parsed.status).toBe('failed');
    if (parsed.status === 'failed') {
      expect(parsed.error_code).toBe('timeout');
    }
  });

  it('rejects unknown statuses and error codes', () => {
    expect(() => RunCodeResultSchema.parse({ status: 'maybe', ...base })).toThrow();
    expect(() => RunCodeResultSchema.parse({ status: 'failed', error_code: 'nope', error: 'x', ...base })).toThrow();
  });
});
