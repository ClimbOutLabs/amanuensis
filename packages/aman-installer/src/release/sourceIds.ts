import { join } from 'node:path';

import type { ProcessRunner } from '../runner/processRunner.ts';
import { sourceIdKeys, type SourceIds } from './manifest.ts';

// The image tags for a checkout, read from the shell that owns them:
// installer/lib/release.sh computes them from git, and this runs its
// own functions so the manifest can never drift from the shell's
// answer. Returns null when the shell cannot answer.

const SCRIPT = [
  'REPO_ROOT="$1"',
  'export REPO_ROOT',
  '. "$2/common.sh"',
  '. "$2/release.sh"',
  'checkout_app_tag',
  'printf \'aman-stt:%s\\n\' "$(source_id ops/aman-stt)"',
  'printf \'aman-tts:%s\\n\' "$(source_id ops/aman-tts)"',
  'printf \'aman-calendar-caldav:%s\\n\' "$(source_id ops/calendar-sidecar)"',
  'printf \'aman-browser:%s\\n\' "$(source_id ops/browser-sidecar)"',
].join('\n');

export async function sourceIdsFromCheckout({
  runner,
  checkoutDir,
  libDir,
}: {
  runner: ProcessRunner;
  checkoutDir: string;
  libDir: string;
}): Promise<SourceIds | null> {
  const result = await runner.run('bash', ['-c', SCRIPT, 'aman-source-ids', checkoutDir, libDir]);
  if (!result.started || result.exitCode !== 0) {
    return null;
  }
  const found: Partial<Record<keyof SourceIds, string>> = {};
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    for (const key of sourceIdKeys()) {
      if (trimmed.startsWith(`${key}:`)) {
        found[key] = trimmed;
      }
    }
  }
  const app = found['aman-app'];
  const stt = found['aman-stt'];
  const tts = found['aman-tts'];
  const calendar = found['aman-calendar-caldav'];
  const browser = found['aman-browser'];
  if (app === undefined || stt === undefined || tts === undefined || calendar === undefined || browser === undefined) {
    return null;
  }
  return {
    'aman-app': app,
    'aman-stt': stt,
    'aman-tts': tts,
    'aman-calendar-caldav': calendar,
    'aman-browser': browser,
  };
}

export function installerLibDir(checkoutDir: string): string {
  return join(checkoutDir, 'installer', 'lib');
}
