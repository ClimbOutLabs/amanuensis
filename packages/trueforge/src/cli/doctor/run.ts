import { checkClock } from './checks/clock';
import { checkDatabase } from './checks/database';
import { checkDisk } from './checks/disk';
import { checkLogin, probeLogin } from './checks/login';
import { checkModel } from './checks/model';
import { checkAttachments, checkRunCode } from './checks/sandbox';
import { checkService } from './checks/service';
import type { DoctorDeps } from './deps';
import { offCheck, type Check } from './schemas';

export const INSTANCE_CHECK_IDS = [
  'service',
  'login',
  'database',
  'disk',
  'clock',
  'run_code',
  'attachments',
  'model',
] as const;

const PROBE_TIMEOUT_MS = 5_000;
const DEEP_PROBE_TIMEOUT_MS = 30_000;
// A model answering a tool call is slower than a health check.
const MODEL_TIMEOUT_MS = 15_000;

/** Runs every instance check; each check isolates its own failure, so one cannot hide another. */
export async function runInstanceChecks({
  deps,
  deep,
  local,
  only,
}: {
  deps: DoctorDeps;
  deep: boolean;
  /** Skips the checks that call an outside service, so a status list stays fast and spends nothing. */
  local: boolean;
  only: string | undefined;
}): Promise<Check[]> {
  const timeoutMs = deep ? DEEP_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS;
  const probe = await probeLogin({ deps, timeoutMs });
  const checks: Check[] = [
    await checkService({ deps, timeoutMs }),
    checkLogin(probe),
    checkDatabase({ deps, timeoutMs }),
    await checkDisk({ deps }),
    checkClock({ deps }),
    await checkRunCode({ deps, timeoutMs }),
    local
      ? offCheck({ id: 'attachments', detail: 'Skipped: the live sandbox test only runs in a full check.' })
      : await checkAttachments({ deps, timeoutMs: DEEP_PROBE_TIMEOUT_MS }),
  ];
  // The model check spends a few tokens, so it only runs when asked for or when nothing is filtered.
  if (local) {
    checks.push(offCheck({ id: 'model', detail: 'Skipped: only checks that need no outside service were asked for.' }));
  } else if (only === undefined || only === 'model') {
    checks.push(await checkModel({ deps, timeoutMs: deep ? DEEP_PROBE_TIMEOUT_MS : MODEL_TIMEOUT_MS }));
  }
  return only === undefined ? checks : checks.filter(check => check.id === only);
}
