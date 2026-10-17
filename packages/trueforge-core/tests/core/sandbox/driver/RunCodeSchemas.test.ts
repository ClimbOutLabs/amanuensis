import {
  RUN_CODE_SETUP_ERROR_CODES,
  RunCodeFileNameSchema,
  RunCodeInputSchema,
  RunCodeResultSchema,
  RunCodeSetupFailureSchema,
} from '../../../../src/core/sandbox/driver/RunCodeSchemas';

const LENGTH_KEYWORDS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']);

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

  it('accepts dot-prefixed basenames up to 256 chars and rejects longer ones', () => {
    for (const ok of ['.env', '..x', '...', 'a'.repeat(256), `.${'a'.repeat(255)}`]) {
      expect(RunCodeFileNameSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ['a'.repeat(257), `..${'a'.repeat(255)}`]) {
      expect(RunCodeFileNameSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('emits no bound above 128 anywhere in the model-facing JSON Schema', () => {
    // vLLM's cached xgrammar compile asserts on bounded repetitions above 128 and takes EngineCore down.
    const limit = 128;
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${path}[${String(i)}]`));
        return;
      }
      if (typeof node !== 'object' || node === null) {
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        const here = `${path}.${key}`;
        if (LENGTH_KEYWORDS.has(key) && typeof value === 'number' && value > limit) {
          offenders.push(`${here}=${String(value)}`);
        }
        if (key === 'pattern' && typeof value === 'string') {
          for (const [, min, max] of value.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
            if (Number(max || min) > limit) {
              offenders.push(`${here} repeats ${max || min}`);
            }
          }
        }
        walk(value, here);
      }
    };
    walk(RunCodeInputSchema.toJSONSchema({ io: 'input' }), '$');
    expect(offenders).toEqual([]);
  });

  it('still enforces the code length cap that the JSON Schema omits', () => {
    expect(RunCodeInputSchema.safeParse({ ...valid, code: 'x'.repeat(512 * 1024) }).success).toBe(true);
    expect(RunCodeInputSchema.safeParse({ ...valid, code: 'x'.repeat(512 * 1024 + 1) }).success).toBe(false);
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

describe('run_code setup failures', () => {
  const fullResult = {
    stdout: '',
    stderr: '',
    stdout_truncated: false,
    stderr_truncated: false,
    files_out: [],
    harvest_warnings: [],
  };

  it('are exactly the codes where no code ran and the text is written for the user', () => {
    expect([...RUN_CODE_SETUP_ERROR_CODES].sort()).toEqual(['daemon_unavailable', 'isolation_refused']);
  });

  it('exclude failures of code that ran or that the model can fix itself', () => {
    for (const code of [
      'timeout',
      'memory_exceeded',
      'disk_exceeded',
      'output_exceeded',
      'invalid_input',
      'internal',
    ]) {
      expect(RUN_CODE_SETUP_ERROR_CODES).not.toContain(code);
      expect(RunCodeSetupFailureSchema.safeParse({ status: 'failed', error_code: code, error: 'text' }).success).toBe(
        false,
      );
    }
    expect(RUN_CODE_SETUP_ERROR_CODES).not.toContain('concurrency_exceeded');
  });

  it('parse from a full failed result without needing its other fields', () => {
    const full = RunCodeResultSchema.parse({
      status: 'failed',
      error_code: 'daemon_unavailable',
      error: 'The sandbox slots are down.',
      ...fullResult,
    });
    expect(RunCodeSetupFailureSchema.parse(full)).toEqual({
      status: 'failed',
      error_code: 'daemon_unavailable',
      error: 'The sandbox slots are down.',
    });
    expect(
      RunCodeSetupFailureSchema.safeParse({ status: 'failed', error_code: 'daemon_unavailable', error: 'x' }).success,
    ).toBe(true);
  });

  it('reject ok results, whatever their output says, and failures without text', () => {
    expect(
      RunCodeSetupFailureSchema.safeParse({ status: 'ok', exit_code: 1, error_code: 'daemon_unavailable', error: 'x' })
        .success,
    ).toBe(false);
    expect(
      RunCodeSetupFailureSchema.safeParse({ status: 'failed', error_code: 'daemon_unavailable', error: '' }).success,
    ).toBe(false);
    expect(RunCodeSetupFailureSchema.safeParse({ status: 'failed', error_code: 'daemon_unavailable' }).success).toBe(
      false,
    );
  });
});
