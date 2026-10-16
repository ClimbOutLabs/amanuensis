import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createWorld,
  DAEMON_TIME,
  find,
  GIB,
  GIB_KB,
  HEALTHY_INSTANCE_CHECKS,
  RUN_CODE_READY,
  sanitize,
} from './world.mjs';

// The document a healthy world prints: same shape and keys as before the text report was restyled.
const HEALTHY_JSON = `{"machine":[{"id":"docker","state":"ok","detail":"Docker 27.1.1 is running and Compose 2.29.1 is available.","fix":""},{"id":"runtime","state":"ok","detail":"A supported Docker runtime is in use.","fix":""},{"id":"credentials","state":"ok","detail":"No Docker settings file, so no credential store is in use.","fix":""},{"id":"images","state":"ok","detail":"All 3 images are ready.","fix":""},{"id":"disk","state":"ok","detail":"50.0 GB is free for Docker data.","fix":""},{"id":"docker_memory","state":"ok","detail":"Docker has 16.0 GB of memory.","fix":""},{"id":"clock","state":"ok","detail":"This machine and Docker agree on the time.","fix":""},{"id":"backup","state":"ok","detail":"No backup yet; one is made automatically before your first upgrade.","fix":""}],"instances":{"main":[{"id":"config","state":"ok","detail":"The settings files exist and are private to you.","fix":""},{"id":"containers","state":"ok","detail":"All 2 parts of instance main are running.","fix":""},{"id":"ports","state":"ok","detail":"Aman listens on this computer only.","fix":""},{"id":"service","state":"ok","detail":"The app answers its health check.","fix":""},{"id":"login","state":"ok","detail":"The login provider answers.","fix":""},{"id":"database","state":"ok","detail":"The database can be written to.","fix":""},{"id":"disk","state":"ok","detail":"50.0 GB is free where the data lives.","fix":""},{"id":"clock","state":"ok","detail":"The clock is within 60 seconds of the login provider.","fix":""},{"id":"run_code","state":"off","detail":"run_code is not available: no sandbox isolation driver is configured for this deployment.","fix":""},{"id":"attachments","state":"off","detail":"Reading email attachments is not available.","fix":""},{"id":"demo","state":"off","detail":"Demo mode is off.","fix":""},{"id":"model","state":"off","detail":"No Token Factory key is set (NEBIUS_API_KEY), so the hosted model is not checked.","fix":""}]}}
`;

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

const ESC = String.fromCharCode(27);

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
        'demo',
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
    assert.match(result.stdout, /\nChecking this computer\n/);
    assert.match(result.stdout, / x Only 1\.0 GB is free for Docker data/);
    assert.match(result.stdout, /Next: Run aman doctor disk --fix/);
    assert.match(result.stdout, /\nChecking instance main\n/);
    assert.match(result.stdout, /1 problem\./);
    assert.match(result.stdout, /Run the Next command for each, then run aman doctor again\./);
  });

  it('prints one line for skipped checks with the same reason, instead of a row each', () => {
    make();
    world.set('info', { out: '', rc: 1, err: 'Cannot connect to the Docker daemon' });
    const result = world.run();
    assert.equal(result.code, 1);
    const flat = result.stdout.replace(/\s+/g, ' ');
    assert.match(flat, /Skipped: Docker is not reachable\. \(images, disk, docker_memory, clock\)/);
    assert.equal(flat.split('Skipped: Docker is not reachable.').length - 1, 2, 'two lines for five skipped checks');
  });

  it('says all checks passed, and shows the ids of the checks with --verbose', () => {
    make();
    const plain = world.run();
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /All checks passed\./);
    assert.doesNotMatch(plain.stdout, /\(docker\)/);
    const verbose = world.run(['--verbose']);
    assert.match(verbose.stdout, /Docker 27\.1\.1 is running and Compose 2\.29\.1 is available\. \(docker\)/);
  });

  it('--summary is one line when everything passed, with the number of checks and nothing else', () => {
    make();
    const result = world.run(['--summary']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout.trim(), /^\S{1,3} All \d+ checks passed$/);
    assert.doesNotMatch(result.stdout, /Instance main|This computer|Full report/);
  });

  it('--summary lists only the problems, once, and counts the checks that passed', () => {
    make();
    world.df(1 * GIB_KB);
    const result = world.run(['--summary']);
    assert.equal(result.code, 1);
    const flat = result.stdout.replace(/\s+/g, ' ');
    assert.match(flat, /This computer x Only 1\.0 GB is free for Docker data/);
    assert.match(flat, /\d+ other checks passed\. Full report: aman doctor/);
    assert.doesNotMatch(flat, /All \d+ checks passed/);
    assert.doesNotMatch(flat, /Docker 27\.1\.1 is running/);
    assert.doesNotMatch(flat, /Instance main/);
  });

  it('keeps color out of a report that is not on a terminal, and uses it when forced', () => {
    make();
    world.df(5 * GIB_KB);
    assert.ok(!world.run().stdout.includes(ESC));
    const forced = world.run([], { env: { CLICOLOR_FORCE: '1', LANG: 'C.UTF-8', TERM: 'xterm' } });
    assert.ok(forced.stdout.includes(`${ESC}[33m!${ESC}[0m`));
    assert.match(forced.stdout, /\u2713/);
    const none = world.run([], { env: { CLICOLOR_FORCE: '1', NO_COLOR: '1', LANG: 'C.UTF-8', TERM: 'xterm' } });
    assert.ok(!none.stdout.includes(ESC));
    assert.match(none.stdout, /\u2713/);
  });

  it('prints the same json document as before the text report was restyled', () => {
    make();
    const result = world.run(['--json']);
    assert.equal(result.stdout, HEALTHY_JSON);
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
    assert.equal(check.fix, 'Run aman doctor docker --fix');
    const elsewhere = world.json([], { env: { AMAN_OS_RELEASE: '/nonexistent' } });
    assert.match(machine(elsewhere, 'docker').fix, /Install Docker Desktop/);
    assert.doesNotMatch(machine(elsewhere, 'docker').fix, /sudo|docs\.docker/);
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
    assert.equal(check.detail, 'Your user cannot use Docker yet.');
    assert.equal(check.fix, 'Run aman doctor docker --fix');
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
      assert.equal(check.detail, 'Docker is installed, but it is not running.', err);
      assert.equal(check.fix, 'Run aman doctor docker --fix', err);
      assert.match(
        machine(world.json([], { env: { AMAN_OS_RELEASE: '/nonexistent' } }), 'docker').fix,
        /Docker Desktop/,
      );
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
    assert.match(check.fix, /Docker Desktop/);
    assert.doesNotMatch(check.fix, /credsStore|config\.json|edit/);
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
    assert.match(check.detail, /not built on this computer: dex_image\./);
    assert.equal(check.fix, 'Run aman upgrade');
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
    assert.equal(check.fix, 'Run aman backup');
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
    assert.equal(check.fix, 'Run aman doctor instance --fix');
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
    assert.equal(check.fix, 'Run aman doctor instance --fix');
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
    assert.match(containersCheck.fix, /aman doctor instance --fix/);
    assert.doesNotMatch(containersCheck.fix, /docker (compose|logs)/);
    assert.equal(find(result.doc.instances.main, 'service').state, 'off');
    assert.equal(result.code, 1);
  });

  it('fails when the app container is down and skips the in-image checks', () => {
    make();
    containers([app({ state: 'exited', status: 'Exited (1) 3 minutes ago' }), dex()]);
    const result = world.json();
    assert.match(find(result.doc.instances.main, 'containers').detail, /The main app is not running\./);
    const service = find(result.doc.instances.main, 'service');
    assert.equal(service.state, 'off', 'one line for the problem, not two');
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
    assert.match(unhealthy.detail, /The main app is not healthy\./);
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
    assert.equal(exposed.detail, 'The main sign-in service is open to the whole network, not just this computer.');
    assert.match(exposed.fix, /aman doctor instance --fix/);
    assert.doesNotMatch(exposed.fix, /compose\.yaml/);
  });

  it('fails the service when the in-image doctor cannot run', () => {
    make();
    world.set('exec_c1', { out: 'OCI runtime exec failed: aman: not found\n', rc: 126 });
    const service = check('service');
    assert.equal(service.state, 'fail');
    assert.match(service.detail, /could not run inside the app container/);
    assert.equal(service.fix, 'Run aman doctor instance --fix');
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
    assert.match(result.stdout, /\+ run_code is ready/);
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
    assert.match(result.stdout, /x The sandbox slots are not running/);
    assert.match(result.stdout, /Next: Run `aman doctor sandbox --fix`/);
  });

  it('fails when the app container is not running', () => {
    make();
    ready();
    world.containers('main', [world.psLine({ id: 'c2', name: 'aman-main-dex-1', service: 'dex' })]);
    const result = world.shim(['doctor', 'sandbox']);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /The main app is not running, so run code could not be tried\./);
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
    assert.match(none.stderr, /Run install\.sh again from the folder Aman was installed from/);
    const repo = ready();
    rmSync(path.join(repo, 'docker-compose.slots.yml'));
    const moved = world.shim(['doctor', 'sandbox']);
    assert.equal(moved.code, 1);
    assert.match(moved.stderr.replace(/\s+/g, ' '), /not at .* any more/);
  });

  it('points to the installer when there is no pinned runtime and the host Node.js is missing or too old', () => {
    make();
    ready();
    const old = world.shim(['doctor', 'sandbox'], { env: { FAKE_NODE_VERSION: 'v22.13.0' } });
    assert.equal(old.code, 1);
    assert.match(old.stderr, /No Node\.js runtime for the sandbox setup/);
    assert.match(old.stderr, /Run install\.sh again from the folder Aman was installed from/);
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
    assert.match(check.stdout.replace(/\s+/g, ' '), /Docker does not start at boot/);
    assert.match(check.stdout.replace(/\s+/g, ' '), /Next: Run aman doctor sandbox --fix/);
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
    assert.match(result.stdout, /Docker is installed, but it is not running\./);
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
    assert.match(
      url.fix,
      /Your cloud may not reach this computer's public address from inside it; this is only a warning\./,
    );
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
    assert.match(
      url.fix,
      /Run aman doctor instance --fix\. If it still fails, the DNS records or the firewall \(port 443\) are the cause\./,
    );
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
    assert.equal(url.fix, 'Run aman doctor instance --fix');
  });

  it('fails when the discovery document names another issuer', () => {
    make();
    world.publicInstance('main');
    world.curlRoute(HEALTH, { body: 'ok' });
    world.curlRoute(DISCOVERY, { body: JSON.stringify({ issuer: 'https://elsewhere.example.net/dex' }) });
    const login = publicChecks()[1];
    assert.equal(login.state, 'fail');
    assert.match(
      login.detail,
      /The sign-in service reports the address https:\/\/elsewhere\.example\.net\/dex, not https:\/\/login\.example\.com\/dex\./,
    );
    assert.equal(login.fix, 'Run aman doctor instance --fix');
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

describe('why an instance does not run', () => {
  const containers = lines => world.containers('main', lines);
  const app = (extra = {}) => world.psLine({ id: 'c1', name: 'aman-main-app-1', service: 'app', ...extra });
  const dex = (extra = {}) => world.psLine({ id: 'c2', name: 'aman-main-dex-1', service: 'dex', ...extra });

  it('names the cause from the container log in one sentence and never asks anyone to read logs', () => {
    make();
    containers([app({ state: 'exited', status: 'Exited (1) 3 minutes ago' }), dex()]);
    world.set('logs_c1', { out: "Error: EACCES: permission denied, mkdir '/home/trueforge'\n" });
    world.set('logs_c2', { out: '' });
    const check = find(world.json().doc.instances.main, 'containers');
    assert.equal(check.state, 'fail');
    assert.match(
      check.detail,
      /The app could not start: it was not allowed to create a folder \(\/home\/trueforge\)\. This is a bug in Aman, not a problem on your computer\./,
    );
    assert.match(check.fix, /aman doctor instance --fix/);
    assert.doesNotMatch(`${check.detail} ${check.fix}`, /docker (compose|logs)|compose\.yaml|\.env/);
  });

  it('shows the state and, with --fix, asks the installer to render the instance again and restart it', () => {
    make();
    const repo = world.sandbox();
    world.installerStub(repo);
    containers([app({ state: 'exited', status: 'Exited (1) 3 minutes ago' }), dex()]);
    const shown = world.shim(['doctor', 'instance']);
    assert.equal(shown.code, 1);
    assert.match(shown.stdout, /x The main app is not running\./);
    assert.ok(!world.calls().some(line => line.startsWith('install.sh')));
    const fixed = world.shim(['doctor', 'instance', '--fix', '--yes']);
    assert.equal(fixed.code, 0, fixed.stderr + fixed.stdout);
    assert.ok(world.calls().includes(`install.sh --home ${world.home} --yes instance refresh main`));
    assert.match(fixed.stdout, /Instance main is fixed/);
  });

  it('fix asks first and changes nothing when the answer is not yes', () => {
    make();
    const repo = world.sandbox();
    world.installerStub(repo);
    containers([app({ state: 'exited', status: 'Exited (1) 3 minutes ago' }), dex()]);
    const result = world.shim(['doctor', 'instance', '--fix']);
    assert.ok(!world.calls().some(line => line.startsWith('install.sh')));
    assert.match(result.stdout + result.stderr, /Restart instance main now\? \[Y\/n\]/);
  });

  it('points to the installer when the checkout it was set up from is not recorded', () => {
    make();
    containers([app({ state: 'exited', status: 'Exited (1) 3 minutes ago' }), dex()]);
    const result = world.shim(['doctor', 'instance', '--fix', '--yes']);
    assert.equal(result.code, 1);
    assert.match(result.stdout.replace(/\s+/g, ' '), /Run install\.sh again from that folder\./);
  });
});

describe('network address check', () => {
  it('records nothing for an instance that is open on this computer only', () => {
    make();
    const result = world.json();
    assert.equal(find(result.doc.instances.main, 'network'), undefined);
  });

  it('is ok while every address of this computer is listed, and calls the open app port intended', () => {
    make();
    world.network('main');
    world.set('port_c1', {
      out: '8790/tcp -> 127.0.0.1:8791\n8790/tcp -> 192.168.1.20:8791\n5556/tcp -> 127.0.0.1:5556\n',
    });
    const result = world.json();
    assert.equal(find(result.doc.instances.main, 'network').state, 'ok');
    assert.match(find(result.doc.instances.main, 'network').detail, /3 addresses/);
    assert.equal(find(result.doc.instances.main, 'ports').state, 'ok');
    assert.match(find(result.doc.instances.main, 'ports').detail, /on purpose/);
  });

  it('does not call the app open to the network when the instance is recorded on this computer only (Mac, WSL2)', () => {
    make();
    world.network('main', { origins: 'http://127.0.0.1:8791,http://localhost:8791' });
    const ports = find(world.json().doc.instances.main, 'ports');
    assert.equal(ports.state, 'ok');
    assert.doesNotMatch(ports.detail, /on purpose|your network/);
    assert.match(ports.detail, /this computer only/);
  });

  it('flags an old record that still lists Tailscale addresses, and points to install.sh', () => {
    make();
    world.network('main', {
      origins: 'http://127.0.0.1:8791,http://localhost:8791,http://192.168.1.20:8791,http://100.101.102.103:8791',
    });
    const check = find(world.json().doc.instances.main, 'network');
    assert.equal(check.state, 'warn');
    assert.match(check.detail, /Tailscale address \(100\.101\.102\.103\)/);
    assert.match(check.fix, /install\.sh/);
  });

  for (const [label, out] of [
    ['the sign-in port', '8790/tcp -> 127.0.0.1:8791\n5556/tcp -> 0.0.0.0:5556\n'],
    ['the app port on every interface', '8790/tcp -> 0.0.0.0:8791\n5556/tcp -> 127.0.0.1:5556\n'],
    ['the app port on every interface (v6)', '8790/tcp -> [::]:8791\n5556/tcp -> 127.0.0.1:5556\n'],
  ]) {
    it(`fails when ${label} is open to the whole network, even for an instance opened on the network`, () => {
      make();
      world.network('main');
      world.set('port_c1', { out });
      const ports = find(world.json().doc.instances.main, 'ports');
      assert.equal(ports.state, 'fail');
      assert.match(ports.fix, /aman doctor instance --fix/);
    });
  }

  it('counts a name given at install as listed', () => {
    make();
    world.network('main', {
      origins: 'http://127.0.0.1:8791,http://localhost:8791,http://192.168.1.20:8791,http://nas.local:8791',
      extraHosts: 'nas.local',
    });
    assert.equal(find(world.json().doc.instances.main, 'network').state, 'ok');
  });

  it('warns, naming the fix, when this computer has an address the instance was not set up for', () => {
    make();
    world.network('main', { addresses: ['127.0.0.1', '192.168.1.20', '192.168.1.77'] });
    const check = find(world.json().doc.instances.main, 'network');
    assert.equal(check.state, 'warn');
    assert.match(
      check.detail,
      /has addresses Aman is not set up for: 192\.168\.1\.77\. Until they are added, every page opened at them is refused/,
    );
    assert.match(check.fix, /aman doctor network --fix/);
    assert.doesNotMatch(check.fix, /\.env|compose\.yaml|docker /);
  });

  it('does not offer a public address of this computer', () => {
    make();
    world.network('main', { addresses: ['127.0.0.1', '192.168.1.20', '203.0.113.9'] });
    assert.equal(find(world.json().doc.instances.main, 'network').state, 'ok');
  });

  it('does not offer a carrier-grade address on any link', () => {
    make();
    world.network('main', {
      addresses: ['127.0.0.1', '192.168.1.20', 'eth1:100.101.102.103', 'tailscale0:100.64.0.7'],
    });
    assert.equal(find(world.json().doc.instances.main, 'network').state, 'ok');
  });

  it('does not offer an address on a container or VPN link', () => {
    make();
    world.network('main', {
      addresses: ['127.0.0.1', '192.168.1.20', 'docker0:172.17.0.1', 'wg0:10.7.0.2', 'tun0:10.8.0.2'],
    });
    assert.equal(find(world.json().doc.instances.main, 'network').state, 'ok');
  });

  it('--fix refreshes the instance through the installer, after a yes', () => {
    make();
    const repo = world.sandbox();
    world.installerStub(repo);
    world.network('main', { addresses: ['127.0.0.1', '192.168.1.20', '192.168.1.77'] });
    const result = world.shim(['doctor', 'network', '--fix', '--yes']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.ok(world.calls().includes(`install.sh --home ${world.home} --yes instance refresh main`));
  });

  it('--fix does nothing when every address is listed', () => {
    make();
    const repo = world.sandbox();
    world.installerStub(repo);
    world.network('main');
    const result = world.shim(['doctor', 'network', '--fix', '--yes']);
    assert.equal(result.code, 0);
    assert.ok(!world.calls().some(line => line.startsWith('install.sh')));
    assert.match(result.stdout, /3 addresses/);
  });

  it('says plainly that an instance on this computer only has no network address', () => {
    make();
    const result = world.shim(['doctor', 'network']);
    assert.equal(result.code, 0);
    assert.match(result.stdout.replace(/\s+/g, ' '), /Open on this computer only/);
  });
});

const LIB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib');

/** The command as the installer lays it out: <home>/bin/aman with the helper files in <home>/lib, or without them. */
function installCommand({ libs }) {
  mkdirSync(path.join(world.home, 'lib'), { recursive: true });
  mkdirSync(path.join(world.home, 'bin'), { recursive: true });
  if (libs) {
    for (const file of readdirSync(LIB_DIR)) {
      copyFileSync(path.join(LIB_DIR, file), path.join(world.home, 'lib', file));
    }
  }
  copyFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'aman'),
    path.join(world.home, 'bin', 'aman'),
  );
}

function runInstalled(args) {
  return spawnSync('bash', [path.join(world.home, 'bin', 'aman'), ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${world.bin}:${path.join(world.root, 'tools')}`,
      HOME: world.root,
      FAKE_DOCKER_DIR: path.join(world.root, 'fake'),
    },
  });
}

describe('https on the network', () => {
  const tlsCheck = () => find(world.json().doc.machine, 'tls');

  it('says nothing about an instance that is not served over https', () => {
    make();
    world.network('main');
    assert.equal(tlsCheck(), undefined);
  });

  it('is ok while the certificate lasts, lists every address, and answers over https', () => {
    make();
    world.tls('main');
    const check = tlsCheck();
    assert.equal(check.state, 'ok');
    assert.match(check.detail, /lasts 300 more days/);
    assert.ok(world.calls().some(line => line.includes('--cacert') && line.includes('https://127.0.0.1:8443/healthz')));
  });

  it('names the fingerprint to compare on a device, and no longer says the daily backup renews it', () => {
    make();
    world.tls('main');
    world.crontab('30 3 * * * /x/aman backup # amanuensis-backup\n');
    const check = tlsCheck();
    assert.match(check.detail, /fingerprint, to compare on a device before trusting it: AA:BB:CC/);
    assert.match(check.detail, /Aman renews it in its last 60 days/);
    assert.doesNotMatch(check.detail, /daily backup/);
  });

  it('warns plainly when backups are off, since renewal then waits for an aman command', () => {
    make();
    world.tls('main');
    mkdirSync(path.join(world.home, 'state'), { recursive: true });
    writeFileSync(path.join(world.home, 'state', 'backups'), 'off\n');
    const check = tlsCheck();
    assert.equal(check.state, 'warn');
    assert.match(
      check.detail,
      /Daily backups are off, so the https certificate is renewed only when you run an aman command/,
    );
    assert.equal(check.fix, 'Run aman doctor backup --fix');
  });

  it('warns about an authority from before it had limits, and about one that does not cover a name, with the one fix', () => {
    make();
    world.tls('main', { constrained: false });
    assert.match(tlsCheck().detail, /has no limit on the names it can vouch for/);
    assert.equal(tlsCheck().fix, 'Run aman doctor tls --fix');
    make();
    world.tls('main', { covers: false });
    assert.match(tlsCheck().detail, /does not cover every name of instance main/);
  });

  it('renews, quietly, from any aman command once 60 days or fewer remain, and not before', () => {
    make();
    const repo = world.sandbox();
    world.installerStub(repo);
    world.tls('main', { endsInSeconds: 61 * 86400 });
    world.shim(['doctor', '--json']);
    assert.ok(!world.calls().includes(`install.sh --home ${world.home} tls`));
    make();
    const repo2 = world.sandbox();
    world.installerStub(repo2);
    world.tls('main', { endsInSeconds: 59 * 86400 });
    world.shim(['doctor', '--json']);
    assert.ok(world.calls().includes(`install.sh --home ${world.home} tls`));
    world.shim(['backup']);
    assert.equal(world.calls().filter(line => line === `install.sh --home ${world.home} tls`).length, 2);
  });

  it('does not renew from inside an installer run', () => {
    make();
    const repo = world.sandbox();
    world.installerStub(repo);
    world.tls('main', { endsInSeconds: 10 * 86400 });
    world.shim(['doctor', '--json'], { env: { AMAN_NO_TLS_RENEW: '1' } });
    assert.ok(!world.calls().includes(`install.sh --home ${world.home} tls`));
  });

  it('warns, with the one fix, when the certificate is close to its end', () => {
    make();
    world.tls('main', { leafDays: 20 });
    const check = tlsCheck();
    assert.equal(check.state, 'warn');
    assert.match(check.detail, /ends in 20 days/);
    assert.equal(check.fix, 'Run aman doctor tls --fix');
  });

  it('fails when the certificate or the authority has run out', () => {
    make();
    world.tls('main', { leafDays: -2 });
    assert.equal(tlsCheck().state, 'fail');
    make();
    world.tls('main', { rootDays: 0 });
    assert.equal(tlsCheck().state, 'fail');
  });

  it('warns when the certificate leaves out an address the instance opens at', () => {
    make();
    world.tls('main', {
      origins: 'http://127.0.0.1:8791,http://localhost:8791,https://192.168.1.20:8443,https://192.168.1.77:8443',
    });
    const check = tlsCheck();
    assert.equal(check.state, 'warn');
    assert.match(check.detail, /does not list: 192\.168\.1\.77/);
  });

  it('fails when the key of the authority can be read by other users', () => {
    make();
    world.tls('main', { keyMode: 0o644 });
    assert.match(tlsCheck().detail, /can be read by other users/);
    assert.equal(tlsCheck().state, 'fail');
  });

  it('fails, naming the instance fix, when https does not answer on this computer', () => {
    make();
    world.tls('main', { healthz: 0 });
    const check = tlsCheck();
    assert.equal(check.state, 'fail');
    assert.match(check.detail, /does not answer over https/);
    assert.equal(check.fix, 'Run aman doctor instance --fix');
  });

  it('--fix renews through the installer and makes the key private again', () => {
    make();
    const repo = world.sandbox();
    world.installerStub(repo);
    world.tls('main', { leafDays: 20, keyMode: 0o644 });
    const result = world.shim(['doctor', 'tls', '--fix', '--yes']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.ok(world.calls().includes(`install.sh --home ${world.home} tls`));
    assert.equal(statSync(path.join(world.home, 'tls', 'ca', 'root.key')).mode & 0o777, 0o600);
  });

  it('knows the https addresses when it compares them with the addresses of this computer', () => {
    make();
    world.tls('main');
    world.network('main', { origins: 'http://127.0.0.1:8791,http://localhost:8791,https://192.168.1.20:8443' });
    const registry = path.join(world.home, 'state', 'instances', 'main.conf');
    writeFileSync(registry, `${readFileSync(registry, 'utf8')}tls=local\ntls_port=8443\n`);
    assert.equal(find(world.json().doc.instances.main, 'network').state, 'ok');
  });
});

describe('aman backup and aman upgrade', () => {
  it('run the installer from the recorded checkout, with the state directory and the arguments given', () => {
    make();
    const repo = world.sandbox();
    world.installerStub(repo);
    assert.equal(world.shim(['backup', 'main']).code, 0);
    assert.equal(world.shim(['upgrade', '--check']).code, 0);
    assert.ok(world.calls().includes(`install.sh --home ${world.home} backup main`));
    assert.ok(world.calls().includes(`install.sh --home ${world.home} upgrade --check`));
  });

  it('say plainly when the folder Aman was installed from is gone', () => {
    make();
    const result = world.shim(['backup']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot find the folder it was installed from/);
  });

  it('find the state directory from where the command is installed, with no setting', () => {
    make();
    const repo = world.sandbox();
    world.installerStub(repo);
    installCommand({ libs: true });
    const result = runInstalled(['backup']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(world.calls().includes(`install.sh --home ${world.home} backup`));
  });
});

describe('the folder Aman runs its installer from', () => {
  function checkoutWith(mode) {
    make();
    const repo = world.sandbox();
    world.installerStub(repo);
    chmodSync(path.join(repo, 'installer', 'install.sh'), mode);
    return repo;
  }

  it('is not used when another user can change its installer, for aman backup and the nightly job', () => {
    checkoutWith(0o666);
    const result = world.shim(['backup']);
    assert.equal(result.code, 1);
    assert.match(
      result.stderr.replace(/\s+/g, ' '),
      /can be changed by other users, so Aman will not run its installer from it\. Run aman doctor checkout --fix/,
    );
    assert.ok(!world.calls().some(line => line.startsWith('install.sh')));
  });

  it('is not used when the folder itself can be written by the group', () => {
    const repo = checkoutWith(0o755);
    chmodSync(repo, 0o775);
    assert.equal(world.shim(['upgrade', '--check']).code, 1);
    assert.ok(!world.calls().some(line => line.startsWith('install.sh')));
  });

  it('is reported by the doctor with the one fix, and --fix makes it private to the user again', () => {
    const repo = checkoutWith(0o666);
    const shown = world.shim(['doctor', 'checkout']);
    assert.equal(shown.code, 1);
    assert.match(shown.stdout.replace(/\s+/g, ' '), /Next: Run aman doctor checkout --fix/);
    const fixed = world.shim(['doctor', 'checkout', '--fix', '--yes']);
    assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
    assert.equal(statSync(path.join(repo, 'installer', 'install.sh')).mode & 0o022, 0);
    assert.equal(world.shim(['backup']).code, 0);
    assert.ok(world.calls().includes(`install.sh --home ${world.home} backup`));
  });

  it('is not used when its installer holds a link, which could point at a file anyone can change', () => {
    const repo = checkoutWith(0o755);
    const elsewhere = path.join(world.root, 'elsewhere.sh');
    writeFileSync(elsewhere, '#!/bin/sh\necho pwned\n', { mode: 0o666 });
    rmSync(path.join(repo, 'installer', 'install.sh'));
    symlinkSync(elsewhere, path.join(repo, 'installer', 'install.sh'));
    const result = world.shim(['backup']);
    assert.equal(result.code, 1);
    assert.match(
      result.stderr.replace(/\s+/g, ' '),
      /contains links, so Aman will not run it\. Copy the folder to one of yours/,
    );
    const shown = world.shim(['doctor', 'checkout']);
    assert.equal(shown.code, 1);
    assert.match(shown.stdout.replace(/\s+/g, ' '), /contains links/);
    assert.equal(
      world.shim(['doctor', 'checkout', '--fix', '--yes']).code,
      1,
      'a link is never made right by changing modes',
    );
  });

  it('is not used when a folder above it can be changed by other users, and --fix never changes that folder', () => {
    checkoutWith(0o755);
    chmodSync(world.root, 0o775);
    const refused = world.shim(['backup']);
    assert.equal(refused.code, 1);
    assert.match(
      refused.stderr.replace(/\s+/g, ' '),
      /A folder above the folder Aman was installed from can be changed by other users/,
    );
    assert.match(refused.stderr.replace(/\s+/g, ' '), /Move the folder to one only you can change/);
    const shown = world.shim(['doctor', 'checkout']);
    assert.equal(shown.code, 1);
    assert.match(shown.stdout.replace(/\s+/g, ' '), /Next: Move the folder to one only you can change/);
    const fixed = world.shim(['doctor', 'checkout', '--fix', '--yes']);
    assert.equal(fixed.code, 1);
    assert.equal(statSync(world.root).mode & 0o777, 0o775, 'a folder above is not Aman to change');
  });

  it('looks at every folder above it, with links resolved', () => {
    const repo = checkoutWith(0o755);
    const high = path.join(world.root, 'high');
    mkdirSync(path.join(high, 'low'), { recursive: true });
    chmodSync(high, 0o775);
    const moved = path.join(high, 'low', 'checkout');
    renameSync(repo, moved);
    writeFileSync(path.join(world.home, 'state', 'source'), `${moved}\n`);
    assert.equal(world.shim(['backup']).code, 1);
    chmodSync(high, 0o755);
    assert.equal(world.shim(['backup']).code, 0);
  });

  it('says nothing about a folder that is private to the user', () => {
    checkoutWith(0o755);
    const result = world.shim(['doctor', 'checkout']);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout, /can be changed/);
  });
});

describe('aman with its helper files missing', () => {
  /** An installer stand-in whose `command` puts the helper files back, as the real one does. */
  function restoringInstaller(repo, { rc = 0 } = {}) {
    const dir = path.join(repo, 'installer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'install.sh'),
      `#!/usr/bin/env bash
echo "install.sh $*" >> "$FAKE_DOCKER_DIR/calls.log"
if [ "$3" = command ] && [ ${rc} = 0 ]; then /bin/cp ${LIB_DIR}/*.sh "$2/lib/"; fi
exit ${rc}
`,
    );
  }

  it('puts a missing helper file back through the installer and carries on', () => {
    make();
    const repo = world.sandbox();
    restoringInstaller(repo);
    installCommand({ libs: true });
    rmSync(path.join(world.home, 'lib', 'network.sh'));
    const result = runInstalled(['backup']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(world.calls().includes(`install.sh --home ${world.home} command`));
    assert.ok(world.calls().includes(`install.sh --home ${world.home} backup`));
  });

  it('runs nothing by itself when the file with the safety checks is the one that is missing, and prints the command', () => {
    make();
    const repo = world.sandbox();
    restoringInstaller(repo);
    installCommand({ libs: false });
    const result = runInstalled(['backup']);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr.trim(),
      `Aman is missing one of its own files. Run: bash ${path.join(repo, 'installer', 'install.sh')} --home ${world.home} command`,
    );
    assert.ok(!world.calls().some(line => line.startsWith('install.sh')));
  });

  it('puts back one missing file among the others', () => {
    make();
    const repo = world.sandbox();
    restoringInstaller(repo);
    installCommand({ libs: true });
    rmSync(path.join(world.home, 'lib', 'schedule.sh'));
    const result = runInstalled(['backup']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(world.calls().includes(`install.sh --home ${world.home} command`));
  });

  it('prints the one command that repairs it when the installer cannot', () => {
    make();
    const repo = world.sandbox();
    restoringInstaller(repo, { rc: 1 });
    installCommand({ libs: true });
    rmSync(path.join(world.home, 'lib', 'schedule.sh'));
    const result = runInstalled(['backup']);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr.trim(),
      `Aman is missing one of its own files. Run: bash ${path.join(repo, 'installer', 'install.sh')} --home ${world.home} command`,
    );
    assert.doesNotMatch(result.stderr, /Run install\.sh again/);
  });

  it('says where to run the installer when the folder Aman was installed from is gone', () => {
    make();
    installCommand({ libs: false });
    const result = runInstalled(['backup']);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /cannot find the folder it was installed from\. Run the installer there: installer\/install\.sh command/,
    );
  });
});

describe('doctor docker, disk and backup', () => {
  it('docker --fix hands the repair to the installer, which asks before any sudo, and passes no yes to it', () => {
    make();
    const repo = world.sandbox();
    world.installerStub(repo);
    world.set('compose_version', { err: 'docker: unknown command', rc: 1 });
    const shown = world.shim(['doctor', 'docker']);
    assert.equal(shown.code, 1);
    assert.match(
      shown.stdout.replace(/\s+/g, ' '),
      /Docker Compose is missing; version 2 is needed\. Next: Run aman doctor docker --fix/,
    );
    assert.ok(!world.calls().some(line => line.startsWith('install.sh')));
    const fixed = world.shim(['doctor', 'docker', '--fix', '--yes']);
    assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
    assert.ok(world.calls().includes(`install.sh --home ${world.home} docker`));
  });

  it('docker says an old Compose is too old, in words', () => {
    make();
    world.set('compose_version', { out: '1.29.2\n', rc: 0 });
    assert.equal(machine(world.json(), 'docker').detail, 'Docker Compose 1.29.2 is too old; version 2 is needed.');
  });

  it('hides the two checks that pass without saying anything, unless asked', () => {
    make();
    const quiet = world.shim(['doctor', 'docker']);
    assert.doesNotMatch(quiet.stdout, /supported Docker runtime|No Docker settings file/);
    assert.match(world.shim(['doctor', 'docker', '--verbose']).stdout, /supported Docker runtime/);
  });

  it('disk shows the check and --fix removes only old Aman images that nothing uses, after asking', () => {
    make();
    world.df(1 * GIB_KB);
    world.set('images', { out: 'aman-app:local\naman-app:old1\naman-stt:old2\ndexidp/dex:v2\naman-stt:local\n' });
    world.set('rmi', { rc: 0 });
    world.set('builder', { rc: 0 });
    const repoWorld = world.sandbox();
    world.installerStub(repoWorld);
    const shown = world.shim(['doctor', 'disk']);
    assert.equal(shown.code, 1);
    assert.match(shown.stdout, /Next: Run aman doctor disk --fix/);
    assert.ok(!world.calls().some(line => line.startsWith('rmi ')));
    const fixed = world.shim(['doctor', 'disk', '--fix', '--yes']);
    assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
    const removed = world.calls().filter(line => line.startsWith('rmi '));
    assert.deepEqual(removed, ['rmi aman-app:old1', 'rmi aman-stt:old2']);
    assert.ok(world.calls().includes('builder prune -f'));
  });

  it('backup: scheduled daily and recent is ok; a missing schedule or an old backup warns with the one fix', () => {
    make();
    mkdirSync(path.join(world.home, 'state'), { recursive: true });
    writeFileSync(path.join(world.home, 'state', 'backups'), 'daily\n');
    world.backup('20261015T030000Z', 0);
    const noSchedule = machine(world.json(), 'backup');
    assert.equal(noSchedule.state, 'warn');
    assert.equal(noSchedule.detail, 'Daily backups are on, but the schedule that runs them is missing.');
    assert.equal(noSchedule.fix, 'Run aman doctor backup --fix');
    world.crontab('30 3 * * * /x/aman backup >/dev/null 2>&1 # amanuensis-backup\n');
    const fine = machine(world.json(), 'backup');
    assert.equal(fine.state, 'ok');
    assert.match(fine.detail, /Daily backups are on; the last one is 0 days old\./);
    world.dispose();
    make();
    mkdirSync(path.join(world.home, 'state'), { recursive: true });
    writeFileSync(path.join(world.home, 'state', 'backups'), 'daily\n');
    world.backup('20261001T030000Z', 5);
    world.crontab('30 3 * * * /x/aman backup # amanuensis-backup\n');
    const stale = machine(world.json(), 'backup');
    assert.equal(stale.state, 'warn');
    assert.match(stale.detail, /scheduled, but the last one is 5 days old/);
  });

  it('backup: off is fine, and warns only when the last backup is old', () => {
    make();
    mkdirSync(path.join(world.home, 'state'), { recursive: true });
    writeFileSync(path.join(world.home, 'state', 'backups'), 'off\n');
    assert.equal(machine(world.json(), 'backup').detail, 'Automatic backups are off.');
    world.backup('x', 20);
    assert.equal(machine(world.json(), 'backup').state, 'warn');
  });

  it('backup --fix turns the daily schedule on and makes a backup now, through the installer', () => {
    make();
    const repo = world.sandbox();
    world.installerStub(repo);
    mkdirSync(path.join(world.home, 'state'), { recursive: true });
    writeFileSync(path.join(world.home, 'state', 'backups'), 'daily\n');
    const shown = world.shim(['doctor', 'backup']);
    assert.equal(shown.code, 0);
    assert.ok(!world.calls().some(line => line.startsWith('install.sh')));
    const fixed = world.shim(['doctor', 'backup', '--fix']);
    assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
    assert.ok(world.calls().includes(`install.sh --home ${world.home} --yes backups daily`));
    assert.ok(world.calls().includes(`install.sh --home ${world.home} --yes backup`));
  });

  it('--yes without --fix is a usage error for each of them', () => {
    make();
    for (const kind of ['docker', 'disk', 'backup']) {
      assert.equal(world.shim(['doctor', kind, '--yes']).code, 2, kind);
    }
  });
});

describe('sandbox settings that are incomplete', () => {
  function incomplete() {
    const repo = world.sandbox();
    world.installerStub(repo);
    writeFileSync(
      path.join(world.instanceDir('main'), 'compose.yaml'),
      'services:\n  app:\n    environment:\n      SANDBOX_BACKEND: slots\n',
    );
    mkdirSync(path.join(world.home, 'state', 'instances'), { recursive: true });
    writeFileSync(
      path.join(world.home, 'state', 'instances', 'main.conf'),
      'name=main\napp_port=8791\nsandbox=slots\n',
    );
    world.set('exec_c1', { out: RUN_CODE_READY, rc: 0 });
    return repo;
  }

  it('is reported with the one fix, and the slot tools are not run on it', () => {
    make();
    incomplete();
    const result = world.shim(['doctor', 'sandbox']);
    assert.equal(result.code, 1);
    assert.match(
      result.stdout.replace(/\s+/g, ' '),
      /The sandbox settings of instance main are incomplete\. Next: Run aman doctor sandbox --fix/,
    );
    assert.ok(!world.calls().some(line => line.startsWith('node ') && line.includes('aman-sandbox.mjs')));
  });

  it('--fix rewrites them the way instance refresh does, then repairs the sandboxes', () => {
    make();
    const repo = incomplete();
    const result = world.shim(['doctor', 'sandbox', '--fix', '--yes']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const calls = world.calls();
    const refresh = calls.indexOf(`install.sh --home ${world.home} --yes instance refresh main`);
    const slots = calls.findIndex(
      line => line.startsWith('node ') && line.includes('aman-sandbox.mjs') && line.includes(repo),
    );
    assert.ok(refresh >= 0, 'the installer rewrote the instance settings');
    assert.ok(slots > refresh, 'the sandboxes were repaired after the settings were rewritten');
  });

  it('an instance installed without the sandbox is left alone', () => {
    make();
    world.sandbox({ wired: [] });
    mkdirSync(path.join(world.home, 'state', 'instances'), { recursive: true });
    writeFileSync(path.join(world.home, 'state', 'instances', 'main.conf'), 'name=main\nsandbox=off\n');
    const result = world.shim(['doctor', 'sandbox']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No instance has the sandbox/);
  });
});
