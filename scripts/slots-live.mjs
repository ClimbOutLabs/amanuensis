// Proves that PDFs and images are read on an installed instance's sandbox, with nothing installed on this machine.
// The live attachment tests run in a throwaway container from a small image that holds Python, Pillow and fonts for
// drawing the test images; it mounts this checkout and the instance's slot control volumes the way its app does.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIX_COMMAND = 'aman doctor sandbox --fix';
const DEFAULT_INSTANCE = 'main';
const INSTANCE_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
const CORE_PACKAGE = 'packages/trueforge-core';
const LIVE_TEST_FILE = 'tests/core/sandbox/slots/slots.integration.test.ts';
const LIVE_TEST_FILTER = 'reading attachments';
const CONTROL_DIR_IN_CONTAINER = '/run/aman-slots';
const JEST_CACHE_VOLUME = 'aman-slots-live-jest-cache';

/** `--instance <name>`, default main. Returns the problem as text when the arguments are not usable. */
export function parseArguments(argv) {
  let instance = DEFAULT_INSTANCE;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    }
    if (argument === '--instance') {
      instance = argv[index + 1] ?? '';
      index += 1;
    } else if (argument.startsWith('--instance=')) {
      instance = argument.slice('--instance='.length);
    } else {
      return { problem: `Unknown argument ${argument}. Usage: pnpm test:slots-live [--instance <name>]` };
    }
  }
  if (!INSTANCE_PATTERN.test(instance)) {
    return { problem: '--instance must be 1 to 24 lowercase letters, digits or hyphens, starting with a letter.' };
  }
  return { instance };
}

/** The Docker volume holding one slot's control socket, as the installer names it. */
export function controlVolumeName({ instance, slot }) {
  return `${instance}_slot_ctl_${String(slot)}`;
}

/** One base image the slot image is built from, so the test image uses ones that are already on the machine. */
export function baseImageFrom({ dockerfileText, argument }) {
  const match = new RegExp(`^ARG ${argument}=(\\S+)$`, 'm').exec(dockerfileText);
  return match === null ? undefined : match[1];
}

/** Node.js (copied from the slot build's own Node image) with Python, Pillow, raqm and fonts for drawing test images. */
export function testImageDockerfile({ nodeImage, ubuntuImage }) {
  return [
    `FROM ${nodeImage} AS node`,
    `FROM ${ubuntuImage}`,
    'COPY --from=node /usr/local/bin/node /usr/local/bin/node',
    'RUN apt-get update \\',
    ' && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-pil libraqm0 fonts-dejavu-core fonts-unifont \\',
    ' && rm -rf /var/lib/apt/lists/*',
    '',
  ].join('\n');
}

/** Named by its content, so a changed recipe builds a new image and an unchanged one is reused. */
export function testImageTag(dockerfileText) {
  return `aman-slots-live:${createHash('sha256').update(dockerfileText).digest('hex').slice(0, 12)}`;
}

const PREPARE_AND_RUN = [
  'set -e',
  'mkdir -p /cache && chown "$HOST_UID:$HOST_GID" /cache',
  `cd "$CHECKOUT/${CORE_PACKAGE}"`,
  // Past this point nothing runs as root, so the checkout gets no root-owned files.
  `exec setpriv --reuid="$HOST_UID" --regid="$HOST_GID" --clear-groups env HOME=/tmp sh -c 'node scripts/generate-sandbox-scripts.mjs && node ./node_modules/jest/bin/jest.js --config jest.config.cjs --cacheDirectory=/cache --runTestsByPath ${LIVE_TEST_FILE} -t "${LIVE_TEST_FILTER}" --json --outputFile=/out/report.json'`,
].join('\n');

/** The `docker run` arguments of the throwaway container. */
export function throwawayContainerArguments({ instance, slotCount, checkout, outputDir, testImage, uid, gid }) {
  const mounts = Array.from({ length: slotCount }, (_, index) => [
    '-v',
    `${controlVolumeName({ instance, slot: index + 1 })}:${CONTROL_DIR_IN_CONTAINER}/${String(index + 1)}:ro`,
  ]).flat();
  return [
    'run',
    '--rm',
    '--user',
    '0',
    '-v',
    `${checkout}:${checkout}`,
    '-v',
    `${outputDir}:/out`,
    '-v',
    `${JEST_CACHE_VOLUME}:/cache`,
    ...mounts,
    '-e',
    `AMAN_SLOTS_TEST_DIR=${CONTROL_DIR_IN_CONTAINER}`,
    '-e',
    'NO_COLOR=1',
    '-e',
    `AMAN_SLOTS_TEST_COUNT=${String(slotCount)}`,
    '-e',
    `CHECKOUT=${checkout}`,
    '-e',
    `HOST_UID=${String(uid)}`,
    '-e',
    `HOST_GID=${String(gid)}`,
    testImage,
    'bash',
    '-c',
    PREPARE_AND_RUN,
  ];
}

function firstLine(text) {
  return (
    text
      .split('\n')
      .map(line => line.trim())
      .find(line => line !== '') ?? ''
  );
}

/** One line per case (✓ or !) and the verdict, from jest's JSON report. */
export function summarizeReport(report) {
  const cases = report.testResults
    .flatMap(file => file.assertionResults)
    .filter(result => result.status === 'passed' || result.status === 'failed');
  const lines = cases.map(result =>
    result.status === 'passed'
      ? `✓ ${result.title}`
      : `! ${result.title}: ${firstLine(result.failureMessages.join('\n'))}`,
  );
  const failed = cases.filter(result => result.status === 'failed').length;
  if (cases.length === 0) {
    lines.push('! No attachment cases ran.');
  }
  const verdict =
    failed === 0 && cases.length > 0
      ? `PASS: ${String(cases.length)} of ${String(cases.length)} cases read correctly on the sandbox.`
      : `FAIL: ${String(failed)} of ${String(cases.length)} cases did not work. Run \`${FIX_COMMAND}\`, then run this again.`;
  return { lines, verdict, ok: failed === 0 && cases.length > 0 };
}

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

function say(text) {
  process.stdout.write(`${text}\n`);
}

/** The reasons this cannot start, as one plain sentence with its one fix; undefined when it can. */
function preflight({ instance, checkout }) {
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) {
    return 'Docker is not running or this account cannot use it. Start Docker, then run this again.';
  }
  const running = docker([
    'ps',
    '--filter',
    `label=com.docker.compose.project=${instance}-slots`,
    '--filter',
    'status=running',
    '--quiet',
  ]);
  if (running.status !== 0 || running.stdout.trim() === '') {
    return `The sandbox of instance ${instance} is not running. Run \`${FIX_COMMAND}\`, then run this again.`;
  }
  if (!existsSync(path.join(checkout, CORE_PACKAGE, 'node_modules', 'jest', 'bin', 'jest.js'))) {
    return 'This checkout has no installed dependencies. Run `pnpm install`, then run this again.';
  }
  return undefined;
}

function slotVolumes(instance) {
  const listed = docker(['volume', 'ls', '--quiet', '--filter', `name=^${instance}_slot_ctl_`]);
  return listed.status === 0 ? listed.stdout.split('\n').filter(name => name !== '') : [];
}

export function main(argv) {
  const parsed = parseArguments(argv);
  if (parsed.problem !== undefined) {
    process.stderr.write(`${parsed.problem}\n`);
    return 2;
  }
  const { instance } = parsed;
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const problem = preflight({ instance, checkout });
  if (problem !== undefined) {
    say(problem);
    return 1;
  }
  const slotCount = slotVolumes(instance).length;
  const slotDockerfile = readFileSync(path.join(checkout, 'ops/sandbox-slot/Dockerfile'), 'utf8');
  const nodeImage = baseImageFrom({ dockerfileText: slotDockerfile, argument: 'NODE_IMAGE' });
  const ubuntuImage = baseImageFrom({ dockerfileText: slotDockerfile, argument: 'UBUNTU_IMAGE' });
  if (slotCount === 0 || nodeImage === undefined || ubuntuImage === undefined) {
    say(`The sandbox of instance ${instance} has no control volumes. Run \`${FIX_COMMAND}\`, then run this again.`);
    return 1;
  }
  const recipe = testImageDockerfile({ nodeImage, ubuntuImage });
  const testImage = testImageTag(recipe);
  if (docker(['image', 'inspect', testImage]).status !== 0) {
    say('Building a small test image once (Python, fonts and OCR test images stay in Docker, not on this machine)...');
    const built = docker(['build', '--tag', testImage, '-'], { input: recipe });
    if (built.status !== 0) {
      say(`! The test image could not be built: ${firstLine(built.stderr.split('\n').slice(-6).join('\n'))}`);
      say('FAIL: nothing ran. Check this machine can reach the Ubuntu package mirror, then run this again.');
      return 1;
    }
  }
  say(`Reading attachments on instance ${instance}...`);
  const outputDir = mkdtempSync(path.join(tmpdir(), 'aman-slots-live-'));
  try {
    const { uid, gid } = userInfo();
    const run = docker(throwawayContainerArguments({ instance, slotCount, checkout, outputDir, testImage, uid, gid }));
    const reportFile = path.join(outputDir, 'report.json');
    if (!existsSync(reportFile)) {
      say(
        `! The test container could not run the cases: ${firstLine(`${run.stderr}\n${run.stdout}`.split('\n').slice(-5).join('\n'))}`,
      );
      say(`FAIL: nothing ran. Run \`${FIX_COMMAND}\`, then run this again.`);
      return 1;
    }
    const summary = summarizeReport(JSON.parse(readFileSync(reportFile, 'utf8')));
    for (const line of summary.lines) {
      say(line);
    }
    say(summary.verdict);
    return summary.ok ? 0 : 1;
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
