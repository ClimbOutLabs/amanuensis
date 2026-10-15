import { checkClock } from './checks/clock';
import { checkDatabase } from './checks/database';
import { checkDisk } from './checks/disk';
import { checkLogin, probeLogin } from './checks/login';
import { checkAttachments, checkRunCode } from './checks/sandbox';
import { checkService } from './checks/service';
import type { DoctorDeps } from './deps';
import type { Check } from './schemas';

export const INSTANCE_CHECK_IDS = ['service', 'login', 'database', 'disk', 'clock', 'run_code', 'attachments'] as const;

const PROBE_TIMEOUT_MS = 5_000;
const DEEP_PROBE_TIMEOUT_MS = 30_000;

/** Runs every instance check; each check isolates its own failure, so one cannot hide another. */
export async function runInstanceChecks({
  deps,
  deep,
  only,
}: {
  deps: DoctorDeps;
  deep: boolean;
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
    checkAttachments(),
  ];
  return only === undefined ? checks : checks.filter(check => check.id === only);
}
