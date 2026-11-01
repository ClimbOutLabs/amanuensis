import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SystemEngineRunner } from '../../src/setup/engine.ts';

// A stand-in installer script, in the one shape that matters here: it
// reads its stdin lines, writes one event line on descriptor 3, and
// prints a plan line. It proves the real runner wires the descriptor,
// the stdin and the output up the way install.sh expects, without the
// real installer.
const FAKE_INSTALL_SH = `#!/bin/sh
if [ "$1" = "--dry-run" ]; then
  printf '  > to do        One step\\n'
  printf '{"type":"phase_start","name":"Checking this computer","index":1,"total":6,"elapsed_seconds":0}\\n' >&3
  cat > /dev/null
  exit 0
fi
if [ "$1" = "docker" ]; then
  echo "docker started"
  exit 0
fi
cat > "$AMAN_FAKE_STDIN"
printf '%s\\n' "$@" > "$AMAN_FAKE_ARGV"
printf '{"type":"final_result","result":"success","verdict_kind":"ok","verdict":"Ready.","elapsed_seconds":1}\\n' >&3
echo "install ran"
`;

async function fakeInstallerDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aman-wizard-engine-'));
  const script = join(dir, 'install.sh');
  await writeFile(script, FAKE_INSTALL_SH);
  await chmod(script, 0o755);
  return dir;
}

test('a dry run returns the output and the events from descriptor 3', async () => {
  const dir = await fakeInstallerDir();
  const engine = new SystemEngineRunner({ installerDir: dir });
  const eventsFile = join(dir, 'events.jsonl');
  const outcome = await engine.dryRun(['--dry-run', '--verbose', '--events', '3'], eventsFile);
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.stdout, /One step/);
  assert.equal(outcome.events.length, 1);
  assert.equal(outcome.events[0]?.type, 'phase_start');
});

test('an install start passes the arguments and writes the stdin lines, then lets go', async () => {
  const dir = await fakeInstallerDir();
  const stdinFile = join(dir, 'stdin.txt');
  const argvFile = join(dir, 'argv.txt');
  process.env['AMAN_FAKE_STDIN'] = stdinFile;
  process.env['AMAN_FAKE_ARGV'] = argvFile;
  try {
    const engine = new SystemEngineRunner({ installerDir: dir });
    const started = await engine.startInstall({
      args: ['--yes', '--events', '3', '--password-stdin'],
      stdinLines: ['the-password'],
      eventsFile: join(dir, 'run-events.jsonl'),
      logFile: join(dir, 'run.log'),
    });
    assert.ok(started.pid > 0);
    // The child is detached; give its writes a moment to land.
    let stdinText = '';
    for (let attempt = 0; attempt < 50 && stdinText === ''; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      stdinText = await readFile(stdinFile, 'utf8').catch(() => '');
    }
    assert.equal(stdinText, 'the-password\n');
    const argvText = await readFile(argvFile, 'utf8');
    assert.ok(argvText.includes('--password-stdin'));
    assert.ok(!argvText.includes('the-password'));
    const log = await readFile(join(dir, 'run.log'), 'utf8');
    assert.match(log, /install ran/);
  } finally {
    delete process.env['AMAN_FAKE_STDIN'];
    delete process.env['AMAN_FAKE_ARGV'];
  }
});
