import {
  DEFAULT_OCR_LANGUAGES,
  DEFAULT_SESSION_DISK_MB,
  requiredOcrLanguages,
  SLOT_FIX_COMMAND,
  slotSocketPathsIn,
} from '@truefoundry/trueforge-core/core';
import type { DoctorDeps } from '../deps';
import { describeNetworkError } from '../redact';
import { failCheck, offCheck, okCheck, warnCheck, type Check } from '../schemas';

const DEFAULT_SLOTS = 4;
const REPAIR = `Run ${SLOT_FIX_COMMAND}`;

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
        detail: 'The sandbox settings for this instance are incomplete.',
        fix: REPAIR,
      }),
    };
  }
  return { ok: true, socketPaths: slotSocketPathsIn({ dir, count }) };
}

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

/** The per-chat quota the server runs with, which decides when a slot counts as full. */
function sessionDiskMb(deps: DoctorDeps): number {
  const configured = Number(deps.env['SANDBOX_SESSION_DISK_MB']);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_SESSION_DISK_MB;
}

const ATTACHMENT_PROBLEMS = {
  sandbox_unavailable: 'The sandbox is not running, so attachments cannot be read.',
  file_not_sent: 'A test file could not be sent into the sandbox.',
  file_changed: 'A test file came back from the sandbox changed.',
  tools_missing: 'This sandbox cannot read PDFs and images yet.',
} as const;

/** Reading PDFs, images and email attachments: a file sent into the sandbox comes back and the sandbox has what it needs to read it. */
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
  const configured = deps.env['DOCUMENT_OCR_LANGUAGES']?.trim();
  const configuredLanguages = configured === undefined || configured === '' ? DEFAULT_OCR_LANGUAGES : configured;
  try {
    const probe = await deps.slotsAttachments({
      socketPaths: settings.socketPaths,
      timeoutMs,
      treeDiskMb: sessionDiskMb(deps),
      // Every language a page may be read with: the configured ones, each script's, and script detection.
      ocrLanguages: requiredOcrLanguages(configuredLanguages),
    });
    if (probe.state === 'ready') {
      return okCheck({
        id,
        detail: 'Reading attachments is ready: PDFs, images and email attachments can be read.',
      });
    }
    if (probe.state === 'busy') {
      // A busy sandbox is not a broken one, and a warning does not stop an upgrade.
      return warnCheck({
        id,
        detail: 'The sandbox was busy, so reading attachments could not be checked.',
        fix: 'Run aman doctor again in a minute.',
      });
    }
    return failCheck({ id, detail: ATTACHMENT_PROBLEMS[probe.problem], fix: REPAIR });
  } catch (error) {
    return failCheck({
      id,
      detail: `Reading attachments could not be checked (${describeNetworkError(error)}).`,
      fix: REPAIR,
    });
  }
}
