import { SLOT_FIX_COMMAND, slotSocketPathsIn } from '@truefoundry/trueforge-core/core';
import type { DoctorDeps } from '../deps';
import { describeNetworkError } from '../redact';
import { failCheck, offCheck, okCheck, type Check } from '../schemas';

const DEFAULT_SLOTS = 4;

type SlotSettings = { ok: true; socketPaths: string[] } | { ok: false; check: Check };

/** The slots this instance was installed with, or the check that says its settings are incomplete. */
function slotSettings({ deps, id }: { deps: DoctorDeps; id: string }): SlotSettings {
  const dir = deps.env['SANDBOX_SLOTS_DIR']?.trim() ?? '';
  const configured = deps.env['SANDBOX_SLOTS']?.trim();
  const count = configured === undefined || configured === '' ? DEFAULT_SLOTS : Number(configured);
  if (dir === '' || !Number.isInteger(count) || count < 1) {
    return {
      ok: false,
      check: failCheck({
        id,
        detail: 'The sandbox settings of this instance are incomplete (SANDBOX_SLOTS_DIR or SANDBOX_SLOTS).',
        fix: 'Run install.sh again; it rewrites the instance compose file with the sandbox settings, then restart the instance.',
      }),
    };
  }
  return { ok: true, socketPaths: slotSocketPathsIn({ dir, count }) };
}

const REPAIR = `Run "${SLOT_FIX_COMMAND}" on the host, then run doctor again.`;

/** run_code through the app's own slot driver: ready only when a slot proves every safety limit to it. */
export async function checkRunCode({ deps, timeoutMs }: { deps: DoctorDeps; timeoutMs: number }): Promise<Check> {
  const id = 'run_code';
  if (deps.env['SANDBOX_BACKEND'] !== 'slots') {
    return offCheck({
      id,
      detail: 'run_code is off: this instance was installed without the sandbox, so the assistant cannot run code.',
    });
  }
  const settings = slotSettings({ deps, id });
  if (!settings.ok) {
    return settings.check;
  }
  try {
    const readiness = await deps.slotsReadiness({ socketPaths: settings.socketPaths, timeoutMs });
    if (readiness.ready) {
      return okCheck({
        id,
        detail: 'run_code is ready: the app reached the sandbox slots and they passed every safety check.',
      });
    }
    return failCheck({ id, detail: readiness.error, fix: REPAIR });
  } catch (error) {
    return failCheck({
      id,
      detail: `The sandbox slots could not be asked (${describeNetworkError(error)}).`,
      fix: REPAIR,
    });
  }
}

/** Reading PDFs, images and email attachments: ready when a file sent into a slot comes back and the guest has the PDF and OCR tools. */
export async function checkAttachments({ deps, timeoutMs }: { deps: DoctorDeps; timeoutMs: number }): Promise<Check> {
  const id = 'attachments';
  if (deps.env['SANDBOX_BACKEND'] !== 'slots') {
    return offCheck({
      id,
      detail:
        'Reading attachments is off: this instance was installed without the sandbox, so the assistant cannot read PDFs, images or email attachments.',
    });
  }
  const settings = slotSettings({ deps, id });
  if (!settings.ok) {
    return settings.check;
  }
  try {
    const probe = await deps.slotsAttachments({ socketPaths: settings.socketPaths, timeoutMs });
    if (probe.ready) {
      return okCheck({
        id,
        detail:
          'Reading attachments is ready: a file sent into the sandbox came back intact and the sandbox can read PDFs and images.',
      });
    }
    return failCheck({ id, detail: probe.error, fix: REPAIR });
  } catch (error) {
    return failCheck({
      id,
      detail: `Reading attachments could not be checked (${describeNetworkError(error)}).`,
      fix: REPAIR,
    });
  }
}
