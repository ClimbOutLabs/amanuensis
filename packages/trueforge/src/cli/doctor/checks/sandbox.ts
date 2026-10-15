import { SLOT_FIX_COMMAND, slotSocketPathsIn } from '@truefoundry/trueforge-core/core';
import type { DoctorDeps } from '../deps';
import { describeNetworkError } from '../redact';
import { failCheck, offCheck, okCheck, type Check } from '../schemas';

const DEFAULT_SLOTS = 4;

/** run_code through the app's own slot driver: ready only when a slot proves every safety limit to it. */
export async function checkRunCode({ deps, timeoutMs }: { deps: DoctorDeps; timeoutMs: number }): Promise<Check> {
  const id = 'run_code';
  if (deps.env['SANDBOX_BACKEND'] !== 'slots') {
    return offCheck({
      id,
      detail: 'run_code is off: this instance was installed without the sandbox, so the assistant cannot run code.',
    });
  }
  const dir = deps.env['SANDBOX_SLOTS_DIR']?.trim() ?? '';
  const configured = deps.env['SANDBOX_SLOTS']?.trim();
  const count = configured === undefined || configured === '' ? DEFAULT_SLOTS : Number(configured);
  if (dir === '' || !Number.isInteger(count) || count < 1) {
    return failCheck({
      id,
      detail: 'The sandbox settings of this instance are incomplete (SANDBOX_SLOTS_DIR or SANDBOX_SLOTS).',
      fix: 'Run install.sh again; it rewrites the instance compose file with the sandbox settings, then restart the instance.',
    });
  }
  try {
    const readiness = await deps.slotsReadiness({ socketPaths: slotSocketPathsIn({ dir, count }), timeoutMs });
    if (readiness.ready) {
      return okCheck({
        id,
        detail: 'run_code is ready: the app reached the sandbox slots and they passed every safety check.',
      });
    }
    return failCheck({
      id,
      detail: readiness.error,
      fix: `Run "${SLOT_FIX_COMMAND}" on the host, then run doctor again.`,
    });
  } catch (error) {
    return failCheck({
      id,
      detail: `The sandbox slots could not be asked (${describeNetworkError(error)}).`,
      fix: `Run "${SLOT_FIX_COMMAND}" on the host, then run doctor again.`,
    });
  }
}

export function checkAttachments(): Check {
  return offCheck({
    id: 'attachments',
    detail:
      'Reading email attachments is not available: it needs the same sandbox as run_code, which arrives in a later release.',
  });
}
