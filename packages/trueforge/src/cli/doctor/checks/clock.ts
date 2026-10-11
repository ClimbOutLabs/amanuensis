import type { DoctorDeps } from '../deps';
import { failCheck, offCheck, okCheck, warnCheck, type Check } from '../schemas';

const CLOCK_WARN_SECONDS = 60;
const CLOCK_FAIL_SECONDS = 300;

/**
 * Compares this container's clock with the host's, which the host command passes as AMAN_HOST_EPOCH
 * (seconds). The login provider runs on the same host, so its clock says nothing about drift.
 */
export function checkClock({ deps }: { deps: DoctorDeps }): Check {
  const id = 'clock';
  const raw = deps.env['AMAN_HOST_EPOCH']?.trim() ?? '';
  if (!/^\d{1,12}$/.test(raw)) {
    return offCheck({
      id,
      detail: 'Skipped: the host did not pass its time. Run doctor through the aman command.',
    });
  }
  const skew = Math.round(Math.abs(deps.nowMs() - Number(raw) * 1000) / 1000);
  const fix =
    'Turn on automatic time sync on this machine (on Docker Desktop, restart it; its clock drifts after sleep), then restart the instance.';
  if (skew > CLOCK_FAIL_SECONDS) {
    return failCheck({
      id,
      detail: `The app's clock differs from the host's by ${String(skew)} seconds; sign-in will fail.`,
      fix,
    });
  }
  if (skew > CLOCK_WARN_SECONDS) {
    return warnCheck({ id, detail: `The app's clock differs from the host's by ${String(skew)} seconds.`, fix });
  }
  return okCheck({ id, detail: `The app's clock is within ${String(CLOCK_WARN_SECONDS)} seconds of the host's.` });
}
