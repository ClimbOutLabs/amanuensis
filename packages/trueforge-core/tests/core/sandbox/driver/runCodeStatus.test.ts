import type { DriverReadiness } from '../../../../src/core/sandbox/driver/IsolationDriver';
import { RunCodeStatusSchema } from '../../../../src/core/sandbox/driver/RunCodeSchemas';
import { runCodeStatusFromReadiness } from '../../../../src/core/sandbox/driver/runCodeStatus';

describe('runCodeStatusFromReadiness', () => {
  it('reports a ready driver without detail', () => {
    expect(runCodeStatusFromReadiness({ ready: true })).toEqual({ state: 'ready' });
  });

  it.each([
    ['docker_unavailable', 'docker_unavailable'],
    ['image_missing', 'image_missing'],
  ] as const)('drops the driver text for %s because the state says it all', (errorCode, state) => {
    expect(runCodeStatusFromReadiness({ ready: false, error_code: errorCode, error: 'driver text' })).toEqual({
      state,
    });
  });

  it('separates a signature failure from other image problems', () => {
    const signature: DriverReadiness = {
      ready: false,
      error_code: 'image_unavailable',
      error: 'cosign signature verification failed',
      reason: 'signature_unverified',
    };
    const pin: DriverReadiness = { ready: false, error_code: 'image_unavailable', error: 'digest mismatch' };
    expect(runCodeStatusFromReadiness(signature)).toEqual({
      state: 'signature_unverified',
      detail: 'cosign signature verification failed',
    });
    expect(runCodeStatusFromReadiness(pin)).toEqual({ state: 'image_unavailable', detail: 'digest mismatch' });
  });

  it('separates an isolation refusal from a daemon problem', () => {
    const refused: DriverReadiness = {
      ready: false,
      error_code: 'daemon_unavailable',
      error: 'canary refused',
      reason: 'isolation_refused',
    };
    const daemon: DriverReadiness = { ready: false, error_code: 'daemon_unavailable', error: 'docker info failed' };
    expect(runCodeStatusFromReadiness(refused).state).toBe('isolation_refused');
    expect(runCodeStatusFromReadiness(daemon)).toEqual({ state: 'daemon_unavailable', detail: 'docker info failed' });
  });

  it('maps the sandbox slots being down to slots_unavailable with the driver text', () => {
    expect(
      runCodeStatusFromReadiness({ ready: false, error_code: 'slots_unavailable', error: 'slots are down' }),
    ).toEqual({
      state: 'slots_unavailable',
      detail: 'slots are down',
    });
  });

  it.each(['unsupported_platform', 'kvm_unavailable'] as const)('maps %s to unsupported_platform', errorCode => {
    expect(runCodeStatusFromReadiness({ ready: false, error_code: errorCode, error: 'not here' })).toEqual({
      state: 'unsupported_platform',
      detail: 'not here',
    });
  });

  it('produces values the wire schema accepts', () => {
    expect(RunCodeStatusSchema.safeParse(runCodeStatusFromReadiness({ ready: true })).success).toBe(true);
  });
});
