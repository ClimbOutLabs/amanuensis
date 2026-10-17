import type { DriverReadiness } from '../../../../src/core/sandbox/driver/IsolationDriver';
import { RunCodeStatusSchema } from '../../../../src/core/sandbox/driver/RunCodeSchemas';
import { runCodeStatusFromReadiness } from '../../../../src/core/sandbox/driver/runCodeStatus';

describe('runCodeStatusFromReadiness', () => {
  it('reports a ready driver without detail', () => {
    expect(runCodeStatusFromReadiness({ ready: true })).toEqual({ state: 'ready' });
  });

  it('separates an isolation refusal from a daemon problem', () => {
    const refused: DriverReadiness = {
      ready: false,
      error_code: 'daemon_unavailable',
      error: 'isolation refused',
      reason: 'isolation_refused',
    };
    const daemon: DriverReadiness = { ready: false, error_code: 'daemon_unavailable', error: 'agent unreachable' };
    expect(runCodeStatusFromReadiness(refused).state).toBe('isolation_refused');
    expect(runCodeStatusFromReadiness(daemon)).toEqual({ state: 'daemon_unavailable', detail: 'agent unreachable' });
  });

  it('maps the sandbox slots being down to slots_unavailable with the driver text', () => {
    expect(
      runCodeStatusFromReadiness({ ready: false, error_code: 'slots_unavailable', error: 'slots are down' }),
    ).toEqual({
      state: 'slots_unavailable',
      detail: 'slots are down',
    });
  });

  it('produces values the wire schema accepts', () => {
    expect(RunCodeStatusSchema.safeParse(runCodeStatusFromReadiness({ ready: true })).success).toBe(true);
  });
});
