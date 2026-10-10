import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCTOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'amanuensis');

export const NOW = 1791633600; // 2026-10-10T12:00:00Z
export const DAEMON_TIME = '2026-10-10T12:00:00.123456789Z';
export const GIB_KB = 1024 * 1024;

const SYSTEM_TOOLS = ['bash', 'sed', 'awk', 'tr', 'cut', 'head', 'date', 'stat', 'timeout', 'cat', 'env', 'dirname'];

const FAKE_DOCKER = `#!/usr/bin/env bash
dir="$FAKE_DOCKER_DIR"
echo "$*" >> "$dir/calls.log"
sanitize() { printf '%s' "$1" | tr -c 'A-Za-z0-9\\n' '_'; }
case "$1" in
  --version) key=cli_version ;;
  info) key=info ;;
  version) key=version ;;
  compose) key="compose_$2" ;;
  ps) key=ps ;;
  port) key="port_$2" ;;
  exec) key="exec_$2" ;;
  image) eval "last=\\\${$#}"; key="image_$(sanitize "$last")" ;;
  *) key=unknown ;;
esac
if [ ! -e "$dir/$key.out" ] && [ ! -e "$dir/$key.rc" ] && [ ! -e "$dir/$key.err" ]; then
  echo "fake docker: no response for $key" >&2
  exit 99
fi
[ -e "$dir/$key.out" ] && cat "$dir/$key.out"
[ -e "$dir/$key.err" ] && cat "$dir/$key.err" >&2
if [ -e "$dir/$key.rc" ]; then exit "$(cat "$dir/$key.rc")"; fi
exit 0
`;

export function sanitize(value) {
  return value.replace(/[^A-Za-z0-9\n]/g, '_');
}

/** A throwaway home, PATH and fake Docker. Everything the doctor script touches lives under `root`. */
export function createWorld({ instances = ['main'] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'aman-doctor-sh-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const tools = path.join(root, 'tools');
  const fake = path.join(root, 'fake');
  const dockerRoot = path.join(root, 'docker-root');
  const dockerConfig = path.join(root, 'docker-config');
  for (const dir of [home, bin, tools, fake, dockerRoot, dockerConfig]) {
    mkdirSync(dir, { recursive: true });
  }

  for (const tool of SYSTEM_TOOLS) {
    const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) {
      symlinkSync(found, path.join(tools, tool));
    }
  }

  const world = {
    root,
    home,
    bin,
    fake,
    dockerRoot,
    dockerConfig,
    instances,
    release: path.join(home, 'release', 'release.json'),
    now: NOW,
    set(key, { out, err, rc } = {}) {
      world.remove(key);
      if (out !== undefined) {
        writeFileSync(path.join(fake, `${key}.out`), out);
      }
      if (err !== undefined) {
        writeFileSync(path.join(fake, `${key}.err`), err);
      }
      if (rc !== undefined) {
        writeFileSync(path.join(fake, `${key}.rc`), String(rc));
      }
    },
    remove(key) {
      for (const ext of ['out', 'err', 'rc']) {
        rmSync(path.join(fake, `${key}.${ext}`), { force: true });
      }
    },
    info({
      version = '27.1.1',
      arch = 'x86_64',
      security = '[name=seccomp,profile=builtin]',
      systime = DAEMON_TIME,
      os = 'Ubuntu 24.04',
    } = {}) {
      world.set('info', { out: `${version}|${arch}|${security}|${dockerRoot}|${systime}|${os}\n`, rc: 0 });
    },
    uninstall(name) {
      rmSync(path.join(bin, name), { force: true });
    },
    install(name, content, mode = 0o755) {
      writeFileSync(path.join(bin, name), content);
      chmodSync(path.join(bin, name), mode);
    },
    df(kb) {
      world.install(
        'df',
        `#!/usr/bin/env bash\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nfake 100000000 1 ${kb} 1%% /\\n'\n`,
      );
    },
    credentialHelper(store, rc) {
      world.install(`docker-credential-${store}`, `#!/usr/bin/env bash\nexit ${rc}\n`);
    },
    instanceDir: name => path.join(home, 'instances', name),
    writeEnv(name, mode = 0o600) {
      const file = path.join(world.instanceDir(name), '.env');
      writeFileSync(file, 'ENV_SECRET=SENTINEL-secret-value\n');
      chmodSync(file, mode);
    },
    psLine({ id, name, state = 'running', status = 'Up 2 minutes', service }) {
      return `${id}|${name}|${state}|${status}|${service}`;
    },
    containers(name, lines) {
      world.set('ps', { out: `${lines.join('\n')}\n`, rc: 0 });
    },
    backup(name, ageDays) {
      const dir = path.join(home, 'backups', name);
      mkdirSync(dir, { recursive: true });
      const when = NOW - ageDays * 86400;
      utimesSync(dir, when, when);
    },
    run(args = [], options) {
      return world.shim(['doctor', ...args], options);
    },
    shim(argv, { env = {} } = {}) {
      const result = spawnSync('bash', [DOCTOR, ...argv], {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${tools}`,
          HOME: root,
          AMANUENSIS_HOME: home,
          DOCKER_CONFIG: dockerConfig,
          FAKE_DOCKER_DIR: fake,
          AMAN_DOCTOR_NOW: String(world.now),
          ...env,
        },
      });
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    json(args = [], options) {
      const result = world.run(['--json', ...args], options);
      return { ...result, doc: result.stdout.trim() === '' ? undefined : JSON.parse(result.stdout) };
    },
    calls: () => {
      try {
        return readFileSync(path.join(fake, 'calls.log'), 'utf8').trim().split('\n');
      } catch {
        return [];
      }
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };

  world.install('docker', FAKE_DOCKER);
  world.df(50 * GIB_KB);
  world.info();
  world.set('cli_version', { out: 'Docker version 27.1.1, build abc\n' });
  world.set('version', { out: 'Docker Engine - Community;containerd;runc;\n' });
  world.set('compose_version', { out: '2.29.1\n' });
  world.set('ps', { out: '' });

  mkdirSync(path.dirname(world.release), { recursive: true });
  writeFileSync(
    world.release,
    JSON.stringify(
      { app_image: 'aman-app:local', dex_image: 'dexidp/dex@sha256:abc', stt_image: 'aman-stt:local' },
      null,
      2,
    ),
  );
  for (const ref of ['aman-app:local', 'dexidp/dex@sha256:abc', 'aman-stt:local']) {
    world.set(`image_${sanitize(ref)}`, { out: 'amd64\n', rc: 0 });
  }

  for (const name of instances) {
    mkdirSync(world.instanceDir(name), { recursive: true });
    world.writeEnv(name);
    world.containers(name, [
      world.psLine({ id: 'c1', name: `aman-${name}-app-1`, service: 'app' }),
      world.psLine({ id: 'c2', name: `aman-${name}-dex-1`, service: 'dex' }),
    ]);
    world.set('port_c1', { out: '8790/tcp -> 127.0.0.1:18790\n' });
    world.set('port_c2', { out: '5556/tcp -> 127.0.0.1:15556\n' });
    world.set('exec_c1', { out: HEALTHY_INSTANCE_CHECKS, rc: 0 });
  }
  return world;
}

export const HEALTHY_INSTANCE_CHECKS =
  [
    'service\tok\tThe app answers its health check.\t',
    'login\tok\tThe login provider answers.\t',
    'database\tok\tThe database can be written to.\t',
    'disk\tok\t50.0 GB is free where the data lives.\t',
    'clock\tok\tThe clock is within 60 seconds of the login provider.\t',
    'run_code\toff\trun_code is not available: no sandbox isolation driver is configured for this deployment.\t',
    'attachments\toff\tReading email attachments is not available.\t',
  ].join('\n') + '\n';

export function find(checks, id) {
  return checks.find(check => check.id === id);
}
