import { SANDBOX_PROMISE, SLOT_FIX_COMMAND, slotSocketPathsIn } from '@truefoundry/trueforge-core/core';
import type { DoctorDeps } from '../deps';
import { describeNetworkError } from '../redact';
import { failCheck, offCheck, okCheck, type Check } from '../schemas';

const DEFAULT_SLOTS = 4;

/** Code runs through the app's own slot driver: ready only when a slot proves every safety limit to it. */
export async function checkRunCode({ deps, timeoutMs }: { deps: DoctorDeps; timeoutMs: number }): Promise<Check> {
  const id = 'run_code';
  const backend = deps.env['SANDBOX_BACKEND']?.trim() ?? '';
  const dir = deps.env['SANDBOX_SLOTS_DIR']?.trim() ?? '';
  if (backend === 'docker') {
    return offCheck({
      id,
      detail: 'This instance is set to an older developer sandbox, which this check does not cover.',
    });
  }
  if (backend === '' && dir === '') {
    return offCheck({
      id,
      detail: "Code won't run: this instance was installed without the sandbox.",
    });
  }
  const configured = deps.env['SANDBOX_SLOTS']?.trim();
  const count = configured === undefined || configured === '' ? DEFAULT_SLOTS : Number(configured);
  if (dir === '' || !Number.isInteger(count) || count < 1) {
    return failCheck({
      id,
      detail: "The sandbox settings of this instance are incomplete, so code won't run.",
      fix: 'Run aman doctor sandbox --fix',
    });
  }
  try {
    const readiness = await deps.slotsReadiness({ socketPaths: slotSocketPathsIn({ dir, count }), timeoutMs });
    if (readiness.ready) {
      return okCheck({
        id,
        detail: `The sandbox is ready: the app reached it and it passed every safety check. ${SANDBOX_PROMISE}`,
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
      detail: `The sandbox could not be asked (${describeNetworkError(error)}).`,
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
