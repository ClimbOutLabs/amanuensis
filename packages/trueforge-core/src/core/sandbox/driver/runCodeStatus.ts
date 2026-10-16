import type { DriverReadiness } from './IsolationDriver';
import type { RunCodeStatus } from './RunCodeSchemas';

/**
 * Maps the isolation driver's readiness onto the status Settings reports. The driver's text is
 * kept only where it adds information beyond the state itself (e.g. the cosign or canary output).
 */
export function runCodeStatusFromReadiness(readiness: DriverReadiness): RunCodeStatus {
  if (readiness.ready) {
    return { state: 'ready' };
  }
  switch (readiness.error_code) {
    case 'docker_unavailable':
      return { state: 'docker_unavailable' };
    case 'image_missing':
      return { state: 'image_missing' };
    case 'image_unavailable':
      return {
        state: readiness.reason === 'signature_unverified' ? 'signature_unverified' : 'image_unavailable',
        detail: readiness.error,
      };
    case 'daemon_unavailable':
      return {
        state: readiness.reason === 'isolation_refused' ? 'isolation_refused' : 'daemon_unavailable',
        detail: readiness.error,
      };
    case 'slots_unavailable':
      return { state: 'slots_unavailable', detail: readiness.error };
    case 'unsupported_platform':
    case 'kvm_unavailable':
      return { state: 'unsupported_platform', detail: readiness.error };
  }
}
