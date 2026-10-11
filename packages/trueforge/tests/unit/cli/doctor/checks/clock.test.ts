import { checkClock } from '../../../../../src/cli/doctor/checks/clock';
import { NOW_MS, fakeDeps } from '../fakeDeps';

function clockWith(hostOffsetMs: number | undefined) {
  const env = hostOffsetMs === undefined ? {} : { AMAN_HOST_EPOCH: String(Math.round((NOW_MS + hostOffsetMs) / 1000)) };
  return checkClock({ deps: fakeDeps({ env }) });
}

describe('clock check against the host', () => {
  it('is ok when the app and the host agree', () => {
    expect(clockWith(5_000).state).toBe('ok');
  });

  it('warns past 60 seconds and fails past 300 seconds, with a fix', () => {
    const warn = clockWith(120_000);
    expect(warn.state).toBe('warn');
    expect(warn.detail).toContain('120');
    expect(warn.fix).not.toBe('');
    const fail = clockWith(-900_000);
    expect(fail.state).toBe('fail');
    expect(fail.fix).not.toBe('');
  });

  it('is off, not guessed from the login provider, when the host did not pass its time', () => {
    const check = clockWith(undefined);
    expect(check.state).toBe('off');
    expect(check.detail).toContain('host');
  });

  it('treats a malformed host time as missing', () => {
    expect(checkClock({ deps: fakeDeps({ env: { AMAN_HOST_EPOCH: 'yesterday' } }) }).state).toBe('off');
  });
});
