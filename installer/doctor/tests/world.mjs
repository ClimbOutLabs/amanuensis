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

const DOCTOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'aman');

export const NOW = 1791633600; // 2026-10-10T12:00:00Z
export const DAEMON_TIME = '2026-10-10T12:00:00.123456789Z';
export const GIB_KB = 1024 * 1024;
export const GIB = 1024 * 1024 * 1024;

const SYSTEM_TOOLS = [
  'bash',
  'sed',
  'awk',
  'tr',
  'cut',
  'head',
  'date',
  'stat',
  'timeout',
  'cat',
  'env',
  'dirname',
  'grep',
  'uname',
  'wc',
  'find',
  'id',
  'chmod',
];

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
  logs) eval "last=\\\${$#}"; key="logs_$last" ;;
  port) key="port_$2" ;;
  exec) shift; while [ "$1" = -e ]; do shift 2; done; key="exec_$1" ;;
  image) eval "last=\\\${$#}"; key="image_$(sanitize "$last")" ;;
  images) key=images ;;
  rmi) key=rmi ;;
  builder) key=builder ;;
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

const FAKE_NODE = `#!/usr/bin/env bash
dir="$FAKE_DOCKER_DIR"
echo "node $*" >> "$dir/calls.log"
if [ "$1" = --version ]; then echo "\${FAKE_NODE_VERSION:-v22.22.0}"; exit 0; fi
[ -e "$dir/node.out" ] && cat "$dir/node.out"
if [ -e "$dir/node.rc" ]; then exit "$(cat "$dir/node.rc")"; fi
exit 0
`;

const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE_DOCKER_DIR/calls.log"
case "$1" in
  cat) exit 0 ;;
  is-enabled) [ -e "$FAKE_DOCKER_DIR/docker_boot_disabled" ] && exit 1; exit 0 ;;
esac
exit 0
`;

const FAKE_SUDO = `#!/usr/bin/env bash
echo "sudo $*" >> "$FAKE_DOCKER_DIR/calls.log"
exit 0
`;

/**
 * A curl that answers from files under $FAKE_DOCKER_DIR: `curl_<n>.out` for the n-th request (0 = exit code only).
 * A request that pins the name with --resolve reads `curl_pinned.*` instead. Each file holds the exit code in
 * `.rc`, the body in `.body` and the status in `.status`.
 */
const FAKE_CURL = `#!/usr/bin/env bash
dir="$FAKE_DOCKER_DIR"
echo "curl $*" >> "$dir/calls.log"
mode=plain
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --resolve) mode=pinned; shift ;;
    --max-time | -w) shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
key=$(printf '%s' "$url" | tr -c 'A-Za-z0-9' '_')
[ "$mode" = pinned ] && key="pinned_$key"
[ -e "$dir/curl_$key.rc" ] || { echo "curl: (6) Could not resolve host" >&2; exit 6; }
rc=$(cat "$dir/curl_$key.rc")
if [ "$rc" != 0 ]; then echo "curl: ($rc) $(cat "$dir/curl_$key.err")" >&2; exit "$rc"; fi
cat "$dir/curl_$key.body" 2>/dev/null
printf '\n%s' "$(cat "$dir/curl_$key.status")"
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

  writeFileSync(path.join(root, 'os-release'), 'ID=ubuntu\n');

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
      memGib = 16,
    } = {}) {
      world.set('info', {
        out: `${version}|${arch}|${security}|${dockerRoot}|${systime}|${os}|${memGib * GIB}\n`,
        rc: 0,
      });
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
    /** The pinned Node.js the installer downloaded; it marks the call log so a test can tell it from the host's. */
    runtimeNode() {
      const dir = path.join(home, 'runtime', 'node', 'bin');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'node'), FAKE_NODE.replace('echo "node $*"', 'echo "runtime-node $*"'));
      chmodSync(path.join(dir, 'node'), 0o755);
    },
    /** A systemd host; Docker is enabled at boot unless `enabled` is false. */
    systemd({ enabled = true } = {}) {
      world.install('systemctl', FAKE_SYSTEMCTL);
      world.install('sudo', FAKE_SUDO);
      if (enabled) {
        rmSync(path.join(fake, 'docker_boot_disabled'), { force: true });
      } else {
        writeFileSync(path.join(fake, 'docker_boot_disabled'), '');
      }
    },
    /** The state the installer leaves for the sandbox: the setup copy, the checkout record and the wired compose file. */
    sandbox({ wired = instances } = {}) {
      const repo = path.join(root, 'checkout');
      mkdirSync(repo, { recursive: true });
      writeFileSync(path.join(repo, 'docker-compose.slots.yml'), 'name: x\n');
      mkdirSync(path.join(home, 'bin'), { recursive: true });
      writeFileSync(path.join(home, 'bin', 'aman-sandbox.mjs'), '// setup\n');
      mkdirSync(path.join(home, 'state'), { recursive: true });
      writeFileSync(path.join(home, 'state', 'source'), `${repo}\n`);
      world.install('node', FAKE_NODE);
      for (const name of wired) {
        writeFileSync(
          path.join(world.instanceDir(name), 'compose.yaml'),
          "services:\n  app:\n    environment:\n      SANDBOX_BACKEND: slots\n      SANDBOX_SLOTS: '4'\n      SANDBOX_SLOTS_DIR: /run/aman-slots\n",
        );
      }
      return repo;
    },
    writeEnv(name, mode = 0o600, extra = '') {
      const file = path.join(world.instanceDir(name), '.env');
      writeFileSync(file, `ENV_SECRET=SENTINEL-secret-value\n${extra}`);
      chmodSync(file, mode);
    },
    /** An instance with public https addresses; \`curl\` answers only the routes a test sets. */
    publicInstance(name, { app = 'https://aman.example.com', login = 'https://login.example.com' } = {}) {
      world.writeEnv(name, 0o600, `PUBLIC_BASE_URL=${app}\nOIDC_ISSUER_URL=${login}/dex\n`);
      world.install('curl', FAKE_CURL);
    },
    /** What curl does for one address: an exit code (and message) or a status with a body. */
    curlRoute(url, { pinned = false, rc = 0, error = '', status = 200, body = '' } = {}) {
      const key = `${pinned ? 'pinned_' : ''}${url.replace(/[^A-Za-z0-9]/g, '_')}`;
      writeFileSync(path.join(fake, `curl_${key}.rc`), String(rc));
      writeFileSync(path.join(fake, `curl_${key}.err`), error);
      writeFileSync(path.join(fake, `curl_${key}.status`), String(status));
      writeFileSync(path.join(fake, `curl_${key}.body`), body);
    },
    /** An instance opened on the local network: its record lists the origins it answers at and `ip` reports this computer's addresses. */
    network(
      name,
      {
        origins = 'http://127.0.0.1:8791,http://localhost:8791,http://192.168.1.20:8791',
        addresses = ['127.0.0.1', '192.168.1.20'],
        extraHosts = '',
      } = {},
    ) {
      const dir = path.join(home, 'state', 'instances');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, `${name}.conf`),
        `name=${name}\napp_port=8791\npublic_url=http://127.0.0.1:8791\norigins=${origins}\nextra_hosts=${extraHosts}\n`,
      );
      const lines = addresses
        .map((entry, index) => {
          const [iface, address] = entry.includes(':') ? entry.split(':') : ['eth0', entry];
          return `${index + 1}: ${iface}    inet ${address}/24 scope global ${iface}`;
        })
        .join('\\n');
      world.install('ip', `#!/usr/bin/env bash\nprintf '${lines}\\n'\n`);
    },
    /** `crontab -l` prints this table; without a call to this, there is no crontab command at all. */
    crontab(text) {
      world.install('crontab', '#!/usr/bin/env bash\ncase "$1" in -l) cat "$FAKE_DOCKER_DIR/crontab" ;; esac\n');
      writeFileSync(path.join(fake, 'crontab'), text);
    },
    /** A stand-in for the installer in the recorded checkout, so a fix can be seen to call it. */
    installerStub(repo, { rc = 0 } = {}) {
      const dir = path.join(repo, 'installer');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'install.sh'),
        `#!/usr/bin/env bash\necho "install.sh $*" >> "$FAKE_DOCKER_DIR/calls.log"\nexit ${rc}\n`,
      );
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
          AMAN_OS_RELEASE: path.join(root, 'os-release'),
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
    'demo\toff\tDemo mode is off.\t',
    'model\toff\tNo Token Factory key is set (NEBIUS_API_KEY), so the hosted model is not checked.\t',
  ].join('\n') + '\n';

export const RUN_CODE_READY = 'run_code\tok\trun_code is ready: the sandbox slots answer through the app.\t\n';

export function find(checks, id) {
  return checks.find(check => check.id === id);
}
