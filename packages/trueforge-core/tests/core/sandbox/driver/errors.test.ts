import { errorCodeForTermination, errorTextForCode, scrubHostPaths } from '../../../../src/core/sandbox/driver/errors';
import { RUN_CODE_SETUP_ERROR_CODES } from '../../../../src/core/sandbox/driver/RunCodeSchemas';

describe('errorCodeForTermination', () => {
  it('maps driver terminations onto the model-visible taxonomy', () => {
    expect(errorCodeForTermination({ terminatedBy: 'timeout', exitCode: -1, oomKilled: false })).toBe('timeout');
    expect(errorCodeForTermination({ terminatedBy: 'oom', exitCode: 137, oomKilled: false })).toBe('memory_exceeded');
    expect(errorCodeForTermination({ terminatedBy: 'killed', exitCode: 137, oomKilled: true })).toBe('memory_exceeded');
    expect(errorCodeForTermination({ terminatedBy: 'killed', exitCode: -1, oomKilled: false })).toBe('internal');
    expect(errorCodeForTermination({ terminatedBy: 'internal', exitCode: -1, oomKilled: false })).toBe('internal');
    expect(errorCodeForTermination({ terminatedBy: 'completed', exitCode: 3, oomKilled: false })).toBe('internal');
  });
});

describe('errorTextForCode', () => {
  it('is human-actionable and carries the anti-workaround rule', () => {
    const text = errorTextForCode({ error_code: 'timeout', detail: undefined });
    expect(text).toContain('time limit');
    expect(text).toContain('do NOT fall back to exec');
  });

  it('appends detail when provided', () => {
    const text = errorTextForCode({ error_code: 'daemon_unavailable', detail: 'socket missing' });
    expect(text).toContain('socket missing');
  });

  it('omits the detail suffix when absent', () => {
    const text = errorTextForCode({ error_code: 'invalid_input', detail: undefined });
    expect(text).not.toContain(':');
  });
});

describe('scrubHostPaths', () => {
  it('replaces the run-root and data-dir prefixes', () => {
    const out = scrubHostPaths({
      text: 'failed at /data/sandbox-runs/abc/ingress/x.py (see /data/logs)',
      runRoot: '/data/sandbox-runs/abc',
      dataDir: '/data',
    });
    expect(out).not.toContain('/data/sandbox-runs/abc');
    expect(out).not.toContain('/data/logs');
    expect(out).toContain('<sandbox>/');
  });

  it('leaves sandbox-internal paths intact', () => {
    const out = scrubHostPaths({
      text: 'wrote /scratch/out.csv and /egress/report.pdf',
      runRoot: '/data/sandbox-runs/abc',
      dataDir: '/data',
    });
    expect(out).toContain('/scratch/out.csv');
    expect(out).toContain('/egress/report.pdf');
  });
});

describe('isolation_refused', () => {
  it('surfaces the isolation_refused detail verbatim', () => {
    const message = "I can't run this safely, the sandbox couldn't apply all isolation guarantees.";
    expect(errorTextForCode({ error_code: 'isolation_refused', detail: message })).toBe(message);
  });

  it('falls back without detail', () => {
    expect(errorTextForCode({ error_code: 'isolation_refused', detail: undefined })).toContain('isolation');
  });
});

describe('setup failure text', () => {
  it.each(RUN_CODE_SETUP_ERROR_CODES)('is written for the user, not the model, for %s', error_code => {
    const text = errorTextForCode({ error_code, detail: 'slot not reachable' });
    expect(text).toContain('slot not reachable');
    expect(text).not.toMatch(/\bexec\b|\bshell tool\b|\bNEVER\b|do NOT/);
  });
});
