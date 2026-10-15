import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DAEMON_TIME,
  GIB,
  GIB_KB,
  HEALTHY_INSTANCE_CHECKS,
  RUN_CODE_READY,
  createWorld,
  find,
  sanitize,
} from './world.mjs';

let world;
const make = options => (world = createWorld(options));
afterEach(() => world?.dispose());

function machine(result, id) {
  return find(result.doc.machine, id);
}

function assertFixed(check) {
  assert.ok(check, 'check present');
  assert.ok(check.fix.trim().length > 0, `${check.id} has a fix`);
}

describe('document and exit codes', () => {
  it('prints {machine, instances} with {id,state,detail,fix} checks and exits 0 when healthy', () => {
    make();
    const result = world.json();
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(Object.keys(result.doc), ['machine', 'instances']);
    assert.deepEqual(Object.keys(result.doc.instances), ['main']);
    for (const check of [...result.doc.machine, ...result.doc.instances.main]) {
      assert.deepEqual(Object.keys(check), ['id', 'state', 'detail', 'fix']);
      assert.ok(['ok', 'warn', 'fail', 'off'].includes(check.state));
      assert.ok(check.detail.length > 0);
      if (check.state === 'warn' || check.state === 'fail') {
        assertFixed(check);
      }
    }
    assert.deepEqual(
      result.doc.machine.map(c => [c.id, c.state]),
      [
        ['docker', 'ok'],
        ['runtime', 'ok'],
        ['credentials', 'ok'],
        ['images', 'ok'],
        ['disk', 'ok'],
        ['docker_memory', 'ok'],
        ['clock', 'ok'],
        ['backup', 'ok'],
      ],
    );
    assert.deepEqual(
      result.doc.instances.main.map(c => c.id),
      [
        'config',
        'containers',
        'ports',
        'service',
        'login',
        'database',
        'disk',
        'clock',
        'run_code',
        'attachments',
        'model',
      ],
    );
  });

  it('exits 1 when any check fails and 0 for warnings only', () => {
    make();
    world.df(5 * GIB_KB);
    assert.equal(world.json().code, 0);
    world.df(1 * GIB_KB);
    assert.equal(world.json().code, 1);
  });

  it('exits 1 when only an in-image instance check fails', () => {
    make();
    world.set('exec_c1', {
      out: HEALTHY_INSTANCE_CHECKS.replace(
        'login\tok\tThe login provider answers.\t',
        'login\tfail\tDex is down.\tStart Dex.',
      ),
      rc: 1,
    });
    const result = world.json();
    assert.equal(result.code, 1);
    assert.deepEqual(find(result.doc.instances.main, 'login'), {
      id: 'login',
      state: 'fail',
      detail: 'Dex is down.',
      fix: 'Start Dex.',
    });
  });

  it('prints a readable report without --json, with the fix under each problem', () => {
    make();
    world.df(1 * GIB_KB);
    const result = world.run();
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^Machine\n/);
    assert.match(result.stdout, /\[FAIL\] disk/);
    assert.match(result.stdout, /Fix: Free space/);
    assert.match(result.stdout, /\nInstance main\n/);
  });

  it('is read-only: only inspection commands reach Docker', () => {
    make();
    world.run();
    const allowed = /^(--version|info|version|compose version|ps|port|exec|image inspect)\b/;
    for (const call of world.calls()) {
      assert.match(call, allowed, call);
    }
  });

  it('escapes quotes and backslashes so the document stays valid JSON', () => {
    make();
    world.set('exec_c1', { out: 'service\tok\tsaid "hi" C:\\path\t\n', rc: 0 });
    assert.equal(find(world.json().doc.instances.main, 'service').detail, 'said "hi" C:\\path');
  });

  it('keeps secrets out of the output', () => {
    make();
    world.set('exec_c1', { out: HEALTHY_INSTANCE_CHECKS, rc: 0 });
    const result = world.run(['--json']);
    assert.ok(!result.stdout.includes('SENTINEL'));
    assert.ok(!result.stderr.includes('SENTINEL'));
  });

  it('reports no instances as an empty object', () => {
    make({ instances: [] });
    assert.deepEqual(world.json().doc.instances, {});
  });
});

describe('usage', () => {
  it('exits 2 for an unknown flag, check or instance, and for a bad name', () => {
    make();
    for (const args of [
      ['--bogus'],
      ['--only', 'nope'],
      ['--instance', 'ghost'],
      ['--instance', 'Bad_Name'],
      ['--only'],
    ]) {
      const result = world.run(args);
      assert.equal(result.code, 2, args.join(' '));
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Usage:/);
    }
  });

  it('needs the doctor command and no longer takes --home (the state directory is AMANUENSIS_HOME)', () => {
    make();
    for (const argv of [[], ['--json'], ['status'], ['doctor', '--home', '/tmp/elsewhere']]) {
      const result = world.shim(argv);
      assert.equal(result.code, 2, argv.join(' '));
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Usage:/);
    }
    assert.equal(world.shim(['doctor', '--json', '--instance', 'main']).code, 0);
  });

  it('--only keeps one check id across machine and instances', () => {
    make();
    const result = world.json(['--only', 'disk']);
    assert.deepEqual(
      result.doc.machine.map(c => c.id),
      ['disk'],
    );
    assert.deepEqual(
      result.doc.instances.main.map(c => c.id),
      ['disk'],
    );
  });

  it('--only ignores failures of other checks when picking the exit code', () => {
    make();
    world.df(1 * GIB_KB);
    assert.equal(world.json(['--only', 'docker']).code, 0);
  });

  it('--instance restricts the instance checks', () => {
    make({ instances: ['main', 'second'] });
    assert.deepEqual(Object.keys(world.json().doc.instances), ['main', 'second']);
    assert.deepEqual(Object.keys(world.json(['--instance', 'second']).doc.instances), ['second']);
  });
});

describe('docker check', () => {
  it('fails with install steps when docker is missing', () => {
    make();
    world.uninstall('docker');
    const check = machine(world.json(), 'docker');
    assert.equal(check.state, 'fail');
    assert.match(check.detail, /not installed/);
    assert.match(check.fix, /docs\.docker\.com\/engine\/install/);
  });

  it('fails with the group fix on a socket permission error', () => {
    make();
    world.set('info', {
      err: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
      rc: 1,
    });
    const result = world.json();
    const check = machine(result, 'docker');
    assert.equal(check.state, 'fail');
    assert.match(check.detail, /not allowed to use its socket/);
    assert.match(check.fix, /usermod -aG docker/);
    assert.match(check.fix, /sign out/);
    assert.equal(result.code, 1);
  });

  it('fails with a start hint when the engine is not running, for each way Docker words it', () => {
    make();
    const messages = [
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
      'error during connect: this error may indicate that the docker daemon is not running',
      'dial unix /var/run/docker.sock: connect: connection refused',
      'Is the docker daemon running?',
    ];
    for (const err of messages) {
      world.set('info', { err, rc: 1 });
      const check = machine(world.json(), 'docker');
      assert.equal(check.state, 'fail', err);
      assert.match(check.detail, /engine is not running/, err);
      assert.match(check.fix, /systemctl start docker/);
      assert.match(check.fix, /Docker Desktop/);
    }
  });

  it('fails with the first line of an unexpected error', () => {
    make();
    world.set('info', { err: 'weird failure\nsecond line', rc: 1 });
    const check = machine(world.json(), 'docker');
    assert.equal(check.state, 'fail');
    assert.match(check.detail, /weird failure/);
    assert.doesNotMatch(check.detail, /second line/);
  });

  it('fails when Compose v2 or newer is missing', () => {
    make();
    world.set('compose_version', { err: 'docker: unknown command: docker compose', rc: 1 });
    assert.equal(machine(world.json(), 'docker').state, 'fail');
    world.set('compose_version', { out: '1.29.2\n', rc: 0 });
    const check = machine(world.json(), 'docker');
    assert.equal(check.state, 'fail');
    assertFixed(check);
  });

  it('accepts Compose v2 and newer, with or without a leading v', () => {
    for (const out of ['v5.2.0', '5.2.0', '2.29.1', 'v2.40.0']) {
      make();
      world.set('compose_version', { out: `${out}\n`, rc: 0 });
      assert.equal(machine(world.json(), 'docker').state, 'ok', out);
    }
  });

  it('rejects an empty or unreadable Compose version', () => {
    for (const out of ['', 'garbage']) {
      make();
      world.set('compose_version', { out: `${out}\n`, rc: 0 });
      assert.equal(machine(world.json(), 'docker').state, 'fail', out);
    }
  });

  it('marks dependent checks off, and each instance service failed, when docker is unreachable', () => {
    make();
    world.set('info', { err: 'Cannot connect to the Docker daemon', rc: 1 });
    const result = world.json();
    for (const id of ['runtime', 'images', 'disk', 'docker_memory', 'clock']) {
      assert.equal(machine(result, id).state, 'off', id);
    }
    const service = find(result.doc.instances.main, 'service');
    assert.equal(service.state, 'fail');
    assertFixed(service);
  });
});

describe('unsupported runtimes', () => {
  it('reports rootless Docker as unsupported', () => {
    make();
    world.info({ security: '[name=seccomp,profile=builtin name=rootless]' });
    const result = world.json();
    const check = machine(result, 'runtime');
    assert.equal(check.state, 'fail');
    assert.match(check.detail, /Rootless Docker is not supported/);
    assertFixed(check);
    assert.equal(result.code, 1);
  });

  it('reports Podman as unsupported, via the engine components or the CLI name', () => {
    make();
    world.set('version', { out: 'Podman Engine;Conmon;OCI Runtime (crun);\n' });
    const check = machine(world.json(), 'runtime');
    assert.equal(check.state, 'fail');
    assert.match(check.detail, /Podman is not supported/);
    assertFixed(check);

    world.set('version', { out: 'Docker Engine - Community;\n' });
    world.set('cli_version', { out: 'podman version 5.0.0\n' });
    assert.equal(machine(world.json(), 'runtime').state, 'fail');
  });
});

describe('credential store check', () => {
  it('is ok with no config file or no store', () => {
    make();
    assert.equal(machine(world.json(), 'credentials').state, 'ok');
    writeFileSync(path.join(world.dockerConfig, 'config.json'), '{"auths": {}}');
    assert.equal(machine(world.json(), 'credentials').state, 'ok');
  });

  it('fails with a fix when the configured helper is not on PATH', () => {
    make();
    writeFileSync(path.join(world.dockerConfig, 'config.json'), '{\n  "credsStore": "desktop"\n}\n');
    const check = machine(world.json(), 'credentials');
    assert.equal(check.state, 'fail');
    assert.match(check.detail, /docker-credential-desktop is not on PATH/);
    assert.match(check.fix, /credsStore/);
    assert.match(check.fix, new RegExp(world.dockerConfig));
  });

  it('fails when the helper is present but does not answer, and passes when it does', () => {
    make();
    writeFileSync(path.join(world.dockerConfig, 'config.json'), '{"credsStore":"osxkeychain"}');
    world.credentialHelper('osxkeychain', 1);
    const bad = machine(world.json(), 'credentials');
    assert.equal(bad.state, 'fail');
    assert.match(bad.detail, /did not answer/);
    assertFixed(bad);
    world.credentialHelper('osxkeychain', 0);
    assert.equal(machine(world.json(), 'credentials').state, 'ok');
  });

  it('is checked even when Docker is down', () => {
    make();
    world.set('info', { err: 'Cannot connect to the Docker daemon', rc: 1 });
    writeFileSync(path.join(world.dockerConfig, 'config.json'), '{"credsStore":"desktop"}');
    assert.equal(machine(world.json(), 'credentials').state, 'fail');
  });
});

describe('images check', () => {
  const ref = key => `image_${sanitize(key)}`;

  it('fails naming each missing image, with the rerun fix', () => {
    make();
    world.set(ref('dexidp/dex@sha256:abc'), { err: 'No such image', rc: 1 });
    const check = machine(world.json(), 'images');
    assert.equal(check.state, 'fail');
    assert.match(check.detail, /missing on this machine: dex_image\./);
    assert.match(check.fix, /install\.sh/);
  });

  it('fails when an image was built for another CPU type', () => {
    make();
    world.set(ref('aman-app:local'), { out: 'arm64\n', rc: 0 });
    const check = machine(world.json(), 'images');
    assert.equal(check.state, 'fail');
    assert.match(check.detail, /app_image\(arm64\)/);
    world.info({ arch: 'aarch64' });
    world.set(ref('aman-stt:local'), { out: 'arm64\n', rc: 0 });
    world.set(ref('dexidp/dex@sha256:abc'), { out: 'arm64\n', rc: 0 });
    assert.equal(machine(world.json(), 'images').state, 'ok');
  });

  it('warns, not fails, when the release record is missing or lists no images', () => {
    make();
    rmSync(world.release);
    const missing = machine(world.json(), 'images');
    assert.equal(missing.state, 'warn');
    assert.match(missing.detail, /No release record/);
    assertFixed(missing);
    writeFileSync(world.release, '{}');
    const empty = machine(world.json(), 'images');
    assert.equal(empty.state, 'warn');
    assert.match(empty.detail, /lists no images/);
  });
});

describe('disk check', () => {
  it('is ok at 10 GB, warns below, fails below 2 GB', () => {
    make();
    world.df(10 * GIB_KB);
    assert.equal(machine(world.json(), 'disk').state, 'ok');
    world.df(10 * GIB_KB - 1);
    const warn = machine(world.json(), 'disk');
    assert.equal(warn.state, 'warn');
    assertFixed(warn);
    world.df(2 * GIB_KB);
    assert.equal(machine(world.json(), 'disk').state, 'warn');
    world.df(2 * GIB_KB - 1);
    const fail = machine(world.json(), 'disk');
    assert.equal(fail.state, 'fail');
    assertFixed(fail);
  });

  it('is off when Docker data lives in a VM that the host cannot see', () => {
    make();
    world.info({});
    world.set('info', { out: `27.1.1|aarch64|[]|/var/lib/docker-in-vm|${DAEMON_TIME}|Docker Desktop\n`, rc: 0 });
    const check = machine(world.json(), 'disk');
    assert.equal(check.state, 'off');
    assert.match(check.detail, /per instance/);
  });

  it('warns when df gives nothing readable', () => {
    make();
    world.install('df', '#!/usr/bin/env bash\nexit 1\n');
    assert.equal(machine(world.json(), 'disk').state, 'warn');
  });
});

describe('docker memory check', () => {
  const at = memGib => {
    world.info({ memGib });
    return machine(world.json(), 'docker_memory');
  };

  it('fails at 4 GiB with the Docker setting named in the fix', () => {
    make();
    const check = at(4);
    assert.equal(check.state, 'fail');
    assert.match(check.detail, /only 4\.0 GB/);
    assert.match(check.fix, /Settings, Resources, Memory/);
    assert.equal(world.json().code, 1);
  });

  it('warns at 7 GiB and is ok at 16 GiB', () => {
    make();
    const warn = at(7);
    assert.equal(warn.state, 'warn');
    assertFixed(warn);
    assert.equal(world.json().code, 0);
    assert.equal(at(16).state, 'ok');
  });

  it('switches state exactly at 6 and 8 GiB', () => {
    make();
    world.info({});
    world.set('info', {
      out: `27.1.1|x86_64|[]|${world.dockerRoot}|${DAEMON_TIME}|Ubuntu|${6 * GIB - 1}\n`,
      rc: 0,
    });
    assert.equal(machine(world.json(), 'docker_memory').state, 'fail');
    assert.equal(at(6).state, 'warn');
    assert.equal(at(8).state, 'ok');
  });

  it('is off when Docker reports no memory figure', () => {
    make();
    world.set('info', { out: `27.1.1|x86_64|[]|${world.dockerRoot}|${DAEMON_TIME}|Ubuntu\n`, rc: 0 });
    assert.equal(machine(world.json(), 'docker_memory').state, 'off');
  });
});

describe('clock skew check', () => {
  const at = offsetSeconds => new Date((1791633600 + offsetSeconds) * 1000).toISOString().replace('.000Z', '.5Z');

  it('is ok within a minute, warns past 60 s, fails past 300 s', () => {
    make();
    world.info({ systime: at(60) });
    assert.equal(machine(world.json(), 'clock').state, 'ok');
    world.info({ systime: at(61) });
    const warn = machine(world.json(), 'clock');
    assert.equal(warn.state, 'warn');
    assert.match(warn.detail, /61 seconds/);
    assertFixed(warn);
    world.info({ systime: at(-301) });
    const fail = machine(world.json(), 'clock');
    assert.equal(fail.state, 'fail');
    assert.match(fail.detail, /301 seconds/);
    assertFixed(fail);
  });

  it('reads time zone offsets, so a +02:00 timestamp for the same instant is ok', () => {
    make();
    world.info({ systime: '2026-10-10T14:00:00+02:00' });
    assert.equal(machine(world.json(), 'clock').state, 'ok');
    world.info({ systime: '2026-10-10T07:00:00.25-05:00' });
    assert.equal(machine(world.json(), 'clock').state, 'ok');
  });

  it('converts leap days and month ends correctly', () => {
    make();
    world.now = 951868799; // 2000-02-29T23:59:59Z
    world.info({ systime: '2000-02-29T23:59:59Z' });
    assert.equal(machine(world.json(), 'clock').state, 'ok');
    world.info({ systime: '2000-03-01T00:00:00Z' });
    assert.equal(machine(world.json(), 'clock').state, 'ok');
    world.info({ systime: '2000-03-01T00:02:00Z' });
    assert.equal(machine(world.json(), 'clock').state, 'warn');
  });

  it('is off when Docker reports an unreadable time', () => {
    make();
    world.info({ systime: 'garbage' });
    assert.equal(machine(world.json(), 'clock').state, 'off');
  });
});

describe('backup age check', () => {
  it('does not warn on a fresh install with no backup yet', () => {
    make();
    const check = machine(world.json(), 'backup');
    assert.equal(check.state, 'ok');
    assert.match(check.detail, /No backup yet/);
  });

  it('is ok for a recent backup and warns after 7 days with the backup command', () => {
    make();
    world.backup('20261008T120000Z', 2);
    assert.equal(machine(world.json(), 'backup').state, 'ok');
    world.dispose();
    make();
    world.backup('20261001T120000Z', 7);
    assert.equal(machine(world.json(), 'backup').state, 'ok');
    world.dispose();
    make();
    world.backup('20260930T120000Z', 9);
    const check = machine(world.json(), 'backup');
    assert.equal(check.state, 'warn');
    assert.match(check.detail, /9 days old/);
    assert.match(check.fix, /install\.sh backup/);
  });

  it('judges by the newest backup', () => {
    make();
    world.backup('old', 30);
    world.backup('new', 1);
    assert.equal(machine(world.json(), 'backup').state, 'ok');
  });
});

describe('instance settings file', () => {
  it('fails with a chmod fix when the file is readable by others', () => {
    make();
    world.writeEnv('main', 0o644);
    const check = find(world.json().doc.instances.main, 'config');
    assert.equal(check.state, 'fail');
    assert.match(check.detail, /mode 644/);
    assert.match(check.fix, /chmod 600 .*instances\/main\/\.env/);
  });

  it('also guards dex.env, which holds the login password hash', () => {
    make();
    const file = path.join(world.instanceDir('main'), 'dex.env');
    writeFileSync(file, "DEX_USER_PASSWORD_HASH='SENTINEL-hash'\n");
    chmodSync(file, 0o600);
    assert.equal(find(world.json().doc.instances.main, 'config').state, 'ok');
    chmodSync(file, 0o644);
    const check = find(world.json().doc.instances.main, 'config');
    assert.equal(check.state, 'fail');
    assert.match(check.detail, /dex\.env/);
    assert.match(check.fix, /chmod 600 .*instances\/main\/dex\.env/);
    assert.doesNotMatch(world.json().stdout, /SENTINEL-hash/);
  });

  it('reports the sign-in user count without printing a hash', () => {
    make();
    const file = path.join(world.instanceDir('main'), 'dex.env');
    writeFileSync(
      file,
      [
        "DEX_USER_PASSWORD_HASH='SENTINEL-owner-hash'",
        "DEX_USER_PASSWORD_HASH_JUDGE1='SENTINEL-judge1-hash'",
        "DEX_USER_PASSWORD_HASH_JUDGE_TWO='SENTINEL-judge2-hash'",
        '',
      ].join('\n'),
    );
    chmodSync(file, 0o600);
    world.writeEnv('main', 0o600, 'OIDC_ALLOWED_EMAILS=o@x.invalid,a@x.invalid,b@x.invalid\n');
    const check = find(world.json().doc.instances.main, 'config');
    assert.equal(check.state, 'ok');
    assert.match(check.detail, /3 sign-in user\(s\): the owner and 2 member\(s\)/);
    assert.doesNotMatch(world.json().stdout, /SENTINEL/);
  });

  it('warns when fewer emails are allowed than there are users', () => {
    make();
    const file = path.join(world.instanceDir('main'), 'dex.env');
    writeFileSync(file, "DEX_USER_PASSWORD_HASH='h1'\nDEX_USER_PASSWORD_HASH_JUDGE1='h2'\n");
    chmodSync(file, 0o600);
    world.writeEnv('main', 0o600, 'OIDC_ALLOWED_EMAILS=o@x.invalid\n');
    const check = find(world.json().doc.instances.main, 'config');
    assert.equal(check.state, 'warn');
    assert.match(check.detail, /2 sign-in user\(s\)/);
    assert.match(check.detail, /Fewer emails are allowed/);
    assert.match(check.fix, /add-user/);
  });

  it('does not warn about a wildcard allowlist', () => {
    make();
    const file = path.join(world.instanceDir('main'), 'dex.env');
    writeFileSync(file, "DEX_USER_PASSWORD_HASH='h1'\nDEX_USER_PASSWORD_HASH_JUDGE1='h2'\n");
    chmodSync(file, 0o600);
    world.writeEnv('main', 0o600, 'OIDC_ALLOWED_EMAILS=*@x.invalid\n');
    assert.equal(find(world.json().doc.instances.main, 'config').state, 'ok');
  });

  it('fails when the file is missing', () => {
    make();
    rmSync(path.join(world.instanceDir('main'), '.env'));
    const check = find(world.json().doc.instances.main, 'config');
    assert.equal(check.state, 'fail');
    assert.match(check.detail, /file is missing/);
    assertFixed(check);
  });
});

describe('instance service health', () => {
  const containers = lines => world.containers('main', lines);
  const app = (extra = {}) => world.psLine({ id: 'c1', name: 'aman-main-app-1', service: 'app', ...extra });
  const dex = (extra = {}) => world.psLine({ id: 'c2', name: 'aman-main-dex-1', service: 'dex', ...extra });
  const check = id => find(world.json().doc.instances.main, id);

  it('relays the in-image checks through docker exec in the app container', () => {
    make();
    const result = world.json(['--deep']);
    assert.equal(find(result.doc.instances.main, 'database').state, 'ok');
    const exec = world.calls().find(call => call.startsWith('exec'));
    assert.equal(exec, `exec -e AMAN_HOST_EPOCH=${world.now} c1 aman doctor --text --deep`);
    assert.ok(world.calls().some(call => call.includes('label=com.docker.compose.project=aman-main')));
  });

  it('passes --only to the in-image doctor only for in-image checks', () => {
    make();
    world.run(['--only', 'login']);
    assert.ok(world.calls().includes(`exec -e AMAN_HOST_EPOCH=${world.now} c1 aman doctor --text --only login`));
    world.run(['--only', 'ports']);
    assert.ok(!world.calls().some(call => call.includes('--only ports')));
  });

  it('fails with the start command when the instance has no containers', () => {
    make();
    world.set('ps', { out: '' });
    const result = world.json();
    const containersCheck = find(result.doc.instances.main, 'containers');
    assert.equal(containersCheck.state, 'fail');
    assert.match(containersCheck.fix, /docker compose --project-directory .*instances\/main up -d/);
    assert.equal(find(result.doc.instances.main, 'service').state, 'fail');
    assert.equal(result.code, 1);
  });

  it('fails when the app container is down and skips the in-image checks', () => {
    make();
    containers([app({ state: 'exited', status: 'Exited (1) 3 minutes ago' }), dex()]);
    const result = world.json();
    assert.match(find(result.doc.instances.main, 'containers').detail, /Not running: aman-main-app-1/);
    const service = find(result.doc.instances.main, 'service');
    assert.equal(service.state, 'fail');
    assertFixed(service);
    assert.ok(!world.calls().some(call => call.startsWith('exec')));
  });

  it('ignores a one-shot container that exited cleanly', () => {
    make();
    containers([
      app(),
      dex(),
      world.psLine({
        id: 'c3',
        name: 'aman-main-init-1',
        state: 'exited',
        status: 'Exited (0) 5 minutes ago',
        service: 'init',
      }),
    ]);
    world.set('port_c3', { out: '' });
    assert.equal(check('containers').state, 'ok');
  });

  it('fails on an unhealthy container and warns on one still starting', () => {
    make();
    containers([app({ status: 'Up 1 minute (unhealthy)' }), dex()]);
    const unhealthy = check('containers');
    assert.equal(unhealthy.state, 'fail');
    assert.match(unhealthy.detail, /Reported unhealthy by Docker: aman-main-app-1/);
    assertFixed(unhealthy);
    containers([app({ status: 'Up 5 seconds (health: starting)' }), dex()]);
    const starting = check('containers');
    assert.equal(starting.state, 'warn');
    assertFixed(starting);
  });

  it('fails when a port is published on all interfaces, and is ok on loopback', () => {
    make();
    assert.equal(check('ports').state, 'ok');
    world.set('port_c2', { out: '5556/tcp -> 0.0.0.0:15556\n5556/tcp -> [::]:15556\n' });
    const exposed = check('ports');
    assert.equal(exposed.state, 'fail');
    assert.match(exposed.detail, /aman-main-dex-1/);
    assert.match(exposed.fix, /127\.0\.0\.1/);
  });

  it('fails the service when the in-image doctor cannot run', () => {
    make();
    world.set('exec_c1', { out: 'OCI runtime exec failed: aman: not found\n', rc: 126 });
    const service = check('service');
    assert.equal(service.state, 'fail');
    assert.match(service.detail, /could not run inside the app container/);
    assert.match(service.fix, /Rebuild the app image/);
  });

  it('drops lines from the in-image doctor with an unknown state', () => {
    make();
    world.set('exec_c1', { out: 'service\tok\tfine\t\nweird\tmaybe\tx\ty\ngarbage line\n', rc: 0 });
    assert.deepEqual(
      world
        .json()
        .doc.instances.main.filter(c => ['service', 'weird'].includes(c.id))
        .map(c => c.id),
      ['service'],
    );
  });

  it('honours AMAN_DOCTOR_APP_SERVICE for the app service name', () => {
    make();
    containers([world.psLine({ id: 'c1', name: 'aman-main-web-1', service: 'web' }), dex()]);
    assert.equal(
      find(world.json(['--only', 'service'], { env: { AMAN_DOCTOR_APP_SERVICE: 'web' } }).doc.instances.main, 'service')
        .state,
      'ok',
    );
  });
});

describe('doctor sandbox', () => {
  const sandboxCalls = () =>
    world.calls().filter(line => line.startsWith('node ') && !line.startsWith('node --version'));

  function ready() {
    const repo = world.sandbox();
    world.set('exec_c1', { out: RUN_CODE_READY, rc: 0 });
    return repo;
  }

  it('checks each slot with the installed setup, then tries run_code through the app, and exits 0', () => {
    make();
    const repo = ready();
    const result = world.shim(['doctor', 'sandbox']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(sandboxCalls(), [
      `node ${world.home}/bin/aman-sandbox.mjs --instance main --repo-root ${repo} --log-file ${world.home}/state/sandbox.log --command-name ${world.home}/bin/aman doctor sandbox --check`,
    ]);
    assert.ok(world.calls().some(line => /^exec .*c1 aman doctor --text --only run_code$/.test(line)));
    assert.match(result.stdout, /Instance main/);
    assert.match(result.stdout, /\[ok {2}\] run_code/);
  });

  it('fails without trying the app when the slots fail their check', () => {
    make();
    ready();
    world.set('node', { rc: 1 });
    const result = world.shim(['doctor', 'sandbox']);
    assert.equal(result.code, 1);
    assert.ok(!world.calls().some(line => line.includes('--only run_code')));
  });

  it('fails with the fix when the app cannot use the slots', () => {
    make();
    ready();
    world.set('exec_c1', {
      out: 'run_code\tfail\tThe sandbox slots are not running.\tRun `aman doctor sandbox --fix`, then check again.\n',
      rc: 1,
    });
    const result = world.shim(['doctor', 'sandbox']);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /FAIL\] run_code/);
    assert.match(result.stdout, /Fix: Run `aman doctor sandbox --fix`/);
  });

  it('fails when the app container is not running', () => {
    make();
    ready();
    world.containers('main', [world.psLine({ id: 'c2', name: 'aman-main-dex-1', service: 'dex' })]);
    const result = world.shim(['doctor', 'sandbox']);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /app container is not running/);
  });

  it('--fix repairs with the same setup: fix, restart, and no prompt of its own', () => {
    make();
    const repo = ready();
    const result = world.shim(['doctor', 'sandbox', '--fix']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(sandboxCalls(), [
      `node ${world.home}/bin/aman-sandbox.mjs --instance main --repo-root ${repo} --log-file ${world.home}/state/sandbox.log --command-name ${world.home}/bin/aman doctor sandbox --fix --restart`,
    ]);
  });

  it('--fix --yes and the disk options are handed on', () => {
    make();
    ready();
    world.shim(['doctor', 'sandbox', '--fix', '--yes', '--disk-gb', '8', '--no-hard-disk-limit']);
    const [call] = sandboxCalls();
    assert.match(call, /--disk-gb 8 --no-hard-disk-limit --fix --restart --yes$/);
  });

  it('--yes without --fix is a usage error', () => {
    make();
    ready();
    const result = world.shim(['doctor', 'sandbox', '--yes']);
    assert.equal(result.code, 2);
    assert.deepEqual(sandboxCalls(), []);
  });

  it('only instances wired to the slots are checked, and --instance picks one', () => {
    make({ instances: ['main', 'plain', 'other'] });
    world.sandbox({ wired: ['main', 'other'] });
    world.set('exec_c1', { out: RUN_CODE_READY, rc: 0 });
    const all = world.shim(['doctor', 'sandbox']);
    assert.equal(all.code, 0, all.stderr);
    assert.deepEqual(
      sandboxCalls().map(line => /--instance (\S+)/.exec(line)?.[1]),
      ['main', 'other'],
    );
    const one = world.shim(['doctor', 'sandbox', '--instance', 'other']);
    assert.equal(one.code, 0);
    assert.equal(sandboxCalls().length, 3);
    const unknown = world.shim(['doctor', 'sandbox', '--instance', 'nope']);
    assert.equal(unknown.code, 2);
  });

  it('says so when no instance has the sandbox', () => {
    make();
    world.sandbox({ wired: [] });
    const result = world.shim(['doctor', 'sandbox']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No instance has the sandbox/);
  });

  it('points to the installer when the setup copy or the checkout record is missing', () => {
    make();
    const none = world.shim(['doctor', 'sandbox']);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /Run install\.sh from the checkout/);
    const repo = ready();
    rmSync(path.join(repo, 'docker-compose.slots.yml'));
    const moved = world.shim(['doctor', 'sandbox']);
    assert.equal(moved.code, 1);
    assert.match(moved.stderr, /not at .* any more/);
  });

  it('points to the installer when there is no pinned runtime and the host Node.js is missing or too old', () => {
    make();
    ready();
    const old = world.shim(['doctor', 'sandbox'], { env: { FAKE_NODE_VERSION: 'v22.13.0' } });
    assert.equal(old.code, 1);
    assert.match(old.stderr, /No Node\.js runtime for the sandbox setup/);
    assert.match(old.stderr, /Run install\.sh from the checkout; it downloads one/);
    world.uninstall('node');
    const missing = world.shim(['doctor', 'sandbox']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No Node\.js runtime for the sandbox setup/);
  });

  it('runs the setup on the pinned runtime when the installer downloaded one, even with no Node.js on the host', () => {
    make();
    ready();
    world.uninstall('node');
    world.runtimeNode();
    const result = world.shim(['doctor', 'sandbox']);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(world.calls().some(line => line.startsWith('runtime-node ') && line.includes('--check')));
  });

  it('prefers the pinned runtime over a host Node.js', () => {
    make();
    ready();
    world.runtimeNode();
    world.shim(['doctor', 'sandbox']);
    assert.ok(world.calls().some(line => line.startsWith('runtime-node ')));
    assert.deepEqual(sandboxCalls(), []);
  });

  it('warns, without failing, when Docker does not start at boot, and enables it with --fix --yes', () => {
    make();
    ready();
    world.systemd({ enabled: false });
    const check = world.shim(['doctor', 'sandbox']);
    assert.equal(check.code, 0, check.stderr);
    assert.match(check.stdout, /Docker does not start at boot/);
    assert.match(check.stdout, /Fix: sudo systemctl enable docker/);
    assert.ok(!world.calls().includes('sudo systemctl enable docker'));
    world.shim(['doctor', 'sandbox', '--fix', '--yes']);
    assert.ok(world.calls().includes('sudo systemctl enable docker'));
  });

  it('says nothing about boot when Docker is enabled or the host has no systemd', () => {
    make();
    ready();
    world.systemd({ enabled: true });
    assert.doesNotMatch(world.shim(['doctor', 'sandbox']).stdout, /start at boot/);
    world.uninstall('systemctl');
    assert.doesNotMatch(world.shim(['doctor', 'sandbox']).stdout, /start at boot/);
  });

  it('stops with the Docker problem when Docker cannot be reached', () => {
    make();
    ready();
    world.set('info', { err: 'Cannot connect to the Docker daemon', rc: 1 });
    const result = world.shim(['doctor', 'sandbox']);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /engine is not running/);
    assert.deepEqual(sandboxCalls(), []);
  });

  it('leaves the plain doctor document unchanged and never runs the setup', () => {
    make();
    ready();
    const result = world.json();
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(sandboxCalls(), []);
  });
});

describe('model check', () => {
  const MODEL_OK = 'model\tok\tToken Factory lists vendor/m and it answered a tool call.\t\n';

  it('shows the in-image model result and passes --only model to the app container', () => {
    make();
    world.set('exec_c1', { out: MODEL_OK, rc: 0 });
    const result = world.json(['--only', 'model']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(find(result.doc.instances.main, 'model'), {
      id: 'model',
      state: 'ok',
      detail: 'Token Factory lists vendor/m and it answered a tool call.',
      fix: '',
    });
    assert.ok(world.calls().includes(`exec -e AMAN_HOST_EPOCH=${world.now} c1 aman doctor --text --only model`));
  });

  it('exits 1 with the fix when the model check fails', () => {
    make();
    world.set('exec_c1', {
      out: HEALTHY_INSTANCE_CHECKS.replace(
        /model\t.*\n/,
        'model\tfail\tToken Factory GET /models: HTTP 401\tCreate a new key.\n',
      ),
      rc: 1,
    });
    const result = world.json();
    assert.equal(result.code, 1);
    assert.equal(find(result.doc.instances.main, 'model').fix, 'Create a new key.');
  });

  it('lets the whole in-image run take as long as a hosted model may', () => {
    make();
    world.run();
    world.run(['--deep']);
    const shim = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'aman'), 'utf8');
    assert.match(shim, /exec_timeout=45/);
    assert.match(shim, /exec_timeout=90/);
  });
});

describe('public https checks', () => {
  const APP = 'https://aman.example.com';
  const LOGIN = 'https://login.example.com';
  const HEALTH = `${APP}/healthz`;
  const DISCOVERY = `${LOGIN}/dex/.well-known/openid-configuration`;
  const DISCOVERY_BODY = JSON.stringify({ issuer: `${LOGIN}/dex`, jwks_uri: `${LOGIN}/dex/keys` }, null, 2);
  const publicChecks = () => world.json().doc.instances.main.filter(check => check.id.startsWith('public_'));

  it('adds nothing for an instance with local addresses only', () => {
    make();
    assert.deepEqual(publicChecks(), []);
  });

  it('is ok when the health endpoint and the discovery document answer over https', () => {
    make();
    world.publicInstance('main');
    world.curlRoute(HEALTH, { body: 'ok' });
    world.curlRoute(DISCOVERY, { body: DISCOVERY_BODY });
    const checks = publicChecks();
    assert.deepEqual(
      checks.map(c => [c.id, c.state]),
      [
        ['public_url', 'ok'],
        ['public_login', 'ok'],
      ],
    );
    assert.ok(world.calls().some(call => call.endsWith(HEALTH)));
    assert.ok(world.calls().some(call => call.endsWith(DISCOVERY)));
    assert.ok(!world.calls().some(call => call.includes('--resolve')), 'no pinned request when the public path works');
  });

  it('warns, not fails, when only the request pinned to this machine works', () => {
    make();
    world.publicInstance('main');
    world.curlRoute(HEALTH, { rc: 28, error: 'Connection timed out' });
    world.curlRoute(HEALTH, { pinned: true, body: 'ok' });
    world.curlRoute(DISCOVERY, { body: DISCOVERY_BODY });
    const [url, login] = publicChecks();
    assert.equal(url.state, 'warn');
    assert.match(url.detail, /not through its public address/);
    assert.match(url.fix, /another network/);
    assert.equal(login.state, 'ok');
    assert.equal(world.json().code, 0);
  });

  it('fails with the curl reason and the DNS, Caddy and firewall fix when nothing answers', () => {
    make();
    world.publicInstance('main');
    world.curlRoute(HEALTH, { rc: 60, error: 'SSL certificate problem' });
    world.curlRoute(HEALTH, { pinned: true, rc: 60, error: 'SSL certificate problem' });
    world.curlRoute(DISCOVERY, { rc: 6, error: 'Could not resolve host' });
    world.curlRoute(DISCOVERY, { pinned: true, rc: 6, error: 'Could not resolve host' });
    const result = world.json();
    const [url, login] = result.doc.instances.main.filter(c => c.id.startsWith('public_'));
    assert.equal(result.code, 1);
    assert.equal(url.state, 'fail');
    assert.match(url.detail, /SSL certificate problem/);
    assert.match(url.fix, /Caddy is running/);
    assert.match(url.fix, /port 443/);
    assert.equal(login.state, 'fail');
  });

  it('fails on a bad gateway and points at the instance doctor', () => {
    make();
    world.publicInstance('main');
    world.curlRoute(HEALTH, { status: 502 });
    world.curlRoute(DISCOVERY, { body: DISCOVERY_BODY });
    const url = publicChecks()[0];
    assert.equal(url.state, 'fail');
    assert.match(url.detail, /status 502/);
    assert.match(url.fix, /aman doctor --instance main/);
  });

  it('fails when the discovery document names another issuer', () => {
    make();
    world.publicInstance('main');
    world.curlRoute(HEALTH, { body: 'ok' });
    world.curlRoute(DISCOVERY, { body: JSON.stringify({ issuer: 'https://elsewhere.example.net/dex' }) });
    const login = publicChecks()[1];
    assert.equal(login.state, 'fail');
    assert.match(login.detail, /issuer is "https:\/\/elsewhere\.example\.net\/dex"/);
    assert.match(login.fix, /OIDC_ISSUER_URL/);
  });

  it('--local makes no public request and asks the app container for local checks only', () => {
    make();
    world.publicInstance('main');
    world.curlRoute(HEALTH, { body: 'ok' });
    const result = world.json(['--local']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      result.doc.instances.main.filter(c => c.id.startsWith('public_')),
      [],
    );
    assert.ok(!world.calls().some(call => call.startsWith('curl')));
    assert.ok(world.calls().includes(`exec -e AMAN_HOST_EPOCH=${world.now} c1 aman doctor --text --local`));
  });

  it('skips with a reason when curl is not installed', () => {
    make();
    world.publicInstance('main');
    world.uninstall('curl');
    const [url] = publicChecks();
    assert.equal(url.state, 'off');
    assert.match(url.detail, /curl is not installed/);
  });

  it('is selectable with --only and keeps secrets out of the report', () => {
    make();
    world.publicInstance('main');
    world.curlRoute(HEALTH, { body: 'ok' });
    world.curlRoute(DISCOVERY, { body: DISCOVERY_BODY });
    const result = world.json(['--only', 'public_login']);
    assert.deepEqual(
      result.doc.instances.main.map(c => c.id),
      ['public_login'],
    );
    assert.ok(!result.stdout.includes('SENTINEL'));
  });
});
