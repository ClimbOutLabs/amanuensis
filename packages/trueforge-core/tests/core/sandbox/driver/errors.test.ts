import { errorCodeForTermination, errorTextForCode, scrubHostPaths } from '../../../../src/core/sandbox/driver/errors';

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
