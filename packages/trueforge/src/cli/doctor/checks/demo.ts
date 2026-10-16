import type { DoctorDeps } from '../deps';
import { offCheck, okCheck, type Check } from '../schemas';

export function checkDemo({ deps }: { deps: DoctorDeps }): Check {
  const id = 'demo';
  if (deps.env['DEMO_MODE']?.trim().toLowerCase() === 'true') {
    return okCheck({ id, detail: 'Demo mode is on: this instance may hold the synthetic demo world.' });
  }
  return offCheck({ id, detail: 'Demo mode is off.' });
}
