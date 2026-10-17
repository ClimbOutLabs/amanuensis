import type { DriverReadiness } from './IsolationDriver';
import type { RunCodeStatus } from './RunCodeSchemas';

/**
 * Maps the isolation driver's readiness onto the status Settings reports. The driver's text is
 * kept as detail.
 */
export function runCodeStatusFromReadiness(readiness: DriverReadiness): RunCodeStatus {
  if (readiness.ready) {
    return { state: 'ready' };
  }
  switch (readiness.error_code) {
    case 'daemon_unavailable':
      return {
        state: readiness.reason === 'isolation_refused' ? 'isolation_refused' : 'daemon_unavailable',
        detail: readiness.error,
      };
    case 'slots_unavailable':
      return { state: 'slots_unavailable', detail: readiness.error };
  }
}
