import { createUi, type Ui } from '../../../../scripts/lib/ui';
import { SlotsReporter } from '../../../../scripts/sandbox-slots/report';
import type { SlotsCheck, SlotsMode, SlotsResult, SlotsStage } from '../../../../scripts/sandbox-slots/slots';

interface Capture {
  ui: Ui;
  out: () => string;
  err: () => string;
  all: () => string;
}

function capture(): Capture {
  let out = '';
  let err = '';
  let all = '';
  const stream = (sink: (text: string) => void) => ({
    write: (text: string): void => {
      sink(text);
      all += text;
    },
    isTTY: false,
    columns: undefined,
  });
  const ui = createUi({
    env: { LANG: 'C', TERM: 'xterm' },
    out: stream(text => void (out += text)),
    err: stream(text => void (err += text)),
    readLine: () => Promise.resolve(undefined),
    verbose: false,
    assumeYes: false,
  });
  return { ui, out: () => out, err: () => err, all: () => all };
}

const OK: SlotsResult = {
  ok: true,
  checks: [],
  image_size_mb: 1842,
  disk: { mode: 'hard', bytes: 16 * 2 ** 30 },
  packs: [],
  warnings: [],
};

function check(step: SlotsCheck['step'], message: string, status: SlotsCheck['status'] = 'ok'): SlotsCheck {
  return { step, status, message };
}

function reporterFor(options: {
  mode?: SlotsMode;
  embedded?: boolean;
  capture: Capture;
  now?: () => number;
}): SlotsReporter {
  return new SlotsReporter({
    ui: options.capture.ui,
    mode: options.mode ?? 'up',
    embedded: options.embedded ?? false,
    logFile: '/home/me/.amanuensis/state/sandbox.log',
    instance: 'aman',
    commandName: 'pnpm sandbox:slots',
    home: '/home/me',
    now: options.now ?? (() => 0),
  });
}

function play(reporter: SlotsReporter, steps: (SlotsStage | SlotsCheck)[]): void {
  for (const step of steps) {
    if (typeof step === 'string') {
      reporter.onStage(step);
    } else {
      reporter.onCheck(step);
    }
  }
}

describe('SlotsReporter', () => {
  it('prints a title, six numbered phases, one line per part, and a closing block', () => {
    const c = capture();
    const reporter = reporterFor({ capture: c });
    reporter.start();
    play(reporter, [
      'docker',
      check('docker', 'Docker 29.1.0 aarch64 is running'),
      check('compose', 'Docker Compose 2.40.0'),
      check('apparmor', 'No AppArmor in this Docker host; the other safety checks still apply', 'info'),
      'image',
      check('build', 'Built amanuensis-sandbox-slot:local'),
      'profile',
      'disks',
      'start',
      check('start', 'Started 2 sandboxes'),
      'attest',
      check('attest', 'All 2 sandboxes passed every safety check'),
    ]);
    reporter.finish({ result: OK, imageSizeMb: 1842 });
    const text = c.all();
    expect(text).toContain('Setting up the sandboxes');
    for (const [n, title] of [
      [1, 'Checking Docker'],
      [2, 'Building the sandbox'],
      [3, 'Safety profile'],
      [4, 'Sandbox disks'],
      [5, 'Starting sandboxes'],
      [6, 'Safety checks'],
    ] as const) {
      expect(text).toContain(`${title} (${String(n)} of 6)`);
    }
    expect(text).toContain('+ Docker 29.1.0 aarch64 is running');
    expect(text).toContain('+ Built the sandbox');
    expect(text).toContain('+ Started 2 sandboxes');
    expect(text).toContain('Ready. 2 sandboxes are running.');
    expect(text).toContain('Image     1.8 GB');
    expect(text).toContain('Disks     2 of 16 GB under /var/lib/aman-slots/aman');
    expect(text).toContain('Log       ~/.amanuensis/state/sandbox.log');
  });

  it('gives a part with nothing to do its own line, so the numbers never skip', () => {
    const c = capture();
    const reporter = reporterFor({ capture: c });
    play(reporter, [
      'docker',
      'image',
      'profile',
      'disks',
      'start',
      check('start', 'Started 2 sandboxes'),
      'attest',
      check('attest', 'ok'),
    ]);
    reporter.finish({ result: OK });
    expect(c.out().match(/- Not needed on this computer/g)).toHaveLength(2);
  });

  it('prints a failure on stderr with what to do next, the output only with --verbose, and where the run stopped', () => {
    const c = capture();
    const reporter = reporterFor({ capture: c });
    play(reporter, ['docker', 'image', 'profile']);
    reporter.finish({
      result: {
        ok: false,
        checks: [],
        step: 'apparmor',
        error: 'Installing and loading the AppArmor profile failed: sudo: apparmor_parser: command not found',
        fix: 'Make sure apparmor_parser is installed (sudo apt install apparmor), then run pnpm sandbox:slots --fix again.',
        detail: 'sudo: apparmor_parser: command not found',
      },
    });
    const err = c.err();
    expect(err).toContain('x Installing and loading the AppArmor profile failed');
    expect(err).not.toContain('command not found');
    expect(err).toContain('Details: --verbose');
    expect(err).toContain('Next: Make sure apparmor_parser is installed');
    expect(err).toContain('Stopped at step 3 of 6.');
    expect(err).not.toContain('- Not needed on this computer');
  });

  it('shows the tool output of a failure with --verbose', () => {
    let err = '';
    const sink = { write: (text: string): void => void (err += text), isTTY: false, columns: undefined };
    const ui = createUi({
      env: { LANG: 'C', TERM: 'xterm' },
      out: sink,
      err: sink,
      readLine: () => Promise.resolve(undefined),
      verbose: true,
      assumeYes: false,
    });
    const reporter = new SlotsReporter({
      ui,
      mode: 'up',
      embedded: false,
      logFile: undefined,
      instance: 'aman',
      commandName: 'pnpm sandbox:slots',
      home: undefined,
      now: () => 0,
    });
    reporter.finish({
      result: { ok: false, checks: [], step: 'build', error: 'Building failed: boom', fix: 'Again.', detail: 'boom' },
    });
    expect(err).toContain('Details: boom');
  });

  it('inside another front end prints only the lines of the parts: no title, phases, Docker lines or closing block', () => {
    const c = capture();
    const reporter = reporterFor({ capture: c, embedded: true, mode: 'build' });
    reporter.start();
    play(reporter, [
      'docker',
      check('docker', 'Docker 29.1.0 aarch64 is running'),
      check('compose', 'Docker Compose 2.40.0'),
      check('apparmor', 'AppArmor is on', 'info'),
      'image',
      check('build', 'Built amanuensis-sandbox-slot:local'),
    ]);
    reporter.finish({ result: OK });
    const text = c.all();
    expect(text).toContain('+ Built the sandbox');
    expect(text).not.toContain('Setting up');
    expect(text).not.toContain('(1 of');
    expect(text).not.toContain('Docker 29.1.0');
    expect(text).not.toContain('Ready.');
    expect(text).not.toMatch(/-{20}/);
  });

  it('repeats a warning in the closing block', () => {
    const c = capture();
    const reporter = reporterFor({ capture: c, mode: 'build' });
    play(reporter, ['docker', 'image', check('build', 'Built amanuensis-sandbox-slot:local')]);
    reporter.finish({ result: { ...OK, warnings: ['The sandboxes have no disk of their own.'] } });
    expect(c.out().match(/The sandboxes have no disk of their own\./g)).toHaveLength(2);
    expect(c.out()).toContain('The sandbox is built.');
  });

  it('shows the elapsed time of a long run in the closing block and leaves a short one out', () => {
    let now = 0;
    const slow = capture();
    const reporter = reporterFor({ capture: slow, now: () => now });
    now = 329_000;
    reporter.finish({ result: OK });
    expect(slow.out()).toContain('Done in 5m 29s');
    const fast = capture();
    const quick = reporterFor({ capture: fast, now: () => 0 });
    quick.finish({ result: OK });
    expect(fast.out()).not.toContain('Done in');
  });
});
