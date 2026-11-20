import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runInstall } from '../../src/commands/install.ts';
import {
  INSTALL_PASSWORD_MISMATCH_LINE,
  LOW_MEMORY,
  problemText,
  WINDOW_CLOSED_EARLY,
  WINDOW_CLOSED_LINE,
  WINDOW_EMAIL_PROBLEM,
  WINDOW_FALLBACK_LINE,
  WINDOW_OPEN_LINE,
  WINDOW_TRY_AGAIN,
} from '../../src/messages.ts';
import type { FromWindow, ToWindow } from '../../src/window/protocol.ts';
import {
  runWindowInstall,
  type WindowChannel,
  type WindowEvent,
  type WindowSessionOptions,
} from '../../src/window/session.ts';
import { makeWorld, PASSWORD, type World } from '../commands/installWorld.ts';

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const HELLO: FromWindow = {
  t: 'hello',
  windowsDir: 'C:\\WINDOWS',
  systemDir: 'C:\\WINDOWS\\system32',
  modulePath: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  languageMode: 'FullLanguage',
};

type Screen = Extract<ToWindow, { t: 'screen' }>;

// A window that stands in for the real one: it keeps what it is sent
// and answers each screen the way the test's person would.
class FakeWindow implements WindowChannel {
  sent: ToWindow[] = [];
  closed = false;
  passwords: Uint8Array[] = [];
  onScreen: (screen: Screen, window: FakeWindow) => void = () => undefined;
  private queue: WindowEvent[] = [];
  private waiting: ((event: WindowEvent) => void)[] = [];

  push(event: WindowEvent): void {
    const waiter = this.waiting.shift();
    if (waiter === undefined) {
      this.queue.push(event);
    } else {
      waiter(event);
    }
  }

  say(message: FromWindow): void {
    this.push({ kind: 'message', message });
  }

  type(password: string): void {
    const bytes = new TextEncoder().encode(password);
    this.passwords.push(bytes);
    this.push({ kind: 'password', bytes });
  }

  send(message: ToWindow): void {
    this.sent.push(message);
    if (message.t === 'screen') {
      this.onScreen(message, this);
    }
  }

  next(): Promise<WindowEvent> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.closed) {
      return Promise.resolve({ kind: 'gone' });
    }
    return new Promise(resolve => {
      this.waiting.push(resolve);
    });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ kind: 'gone' });
    }
  }

  screens(): string[] {
    return this.sent.filter((message): message is Screen => message.t === 'screen').map(screen => screen.name);
  }

  problems(): string[] {
    return this.sent
      .filter((message): message is Extract<ToWindow, { t: 'problem' }> => message.t === 'problem')
      .map(message => message.text);
  }
}

interface Person {
  email?: string;
  password?: string;
  again?: string;
  phone?: boolean;
}

// A person who answers every screen and goes forward.
function person(answers: Person = {}): (screen: Screen, window: FakeWindow) => void {
  return (screen, window) => {
    if (screen.next === null) {
      return;
    }
    if (screen.name === 'about') {
      window.type(answers.password ?? PASSWORD);
      window.type(answers.again ?? answers.password ?? PASSWORD);
      window.say({ t: 'about', email: answers.email ?? 'friend@example.com' });
    } else if (screen.name === 'options') {
      window.say({ t: 'options', phone: answers.phone ?? true });
    } else {
      window.say({ t: 'next' });
    }
  };
}

function sessionOptions(window: FakeWindow, overrides: Partial<WindowSessionOptions> = {}): WindowSessionOptions {
  return {
    channel: window,
    powershellPath: POWERSHELL,
    windowsDir: 'C:\\Windows',
    helloWait: () => new Promise<void>(() => undefined),
    ...overrides,
  };
}

function openWindow(react: (screen: Screen, window: FakeWindow) => void = person()): FakeWindow {
  const window = new FakeWindow();
  window.onScreen = react;
  window.say(HELLO);
  return window;
}

function everythingShown(world: World, window: FakeWindow): string {
  return `${JSON.stringify(window.sent)}\n${world.printed.join('\n')}\n${world.recording.lines().join('\n')}`;
}

test('the window walks the screens in order, installs, and the password reaches only the installer', async () => {
  const world = await makeWorld();
  const window = openWindow();
  const outcome = await runWindowInstall(world.deps, sessionOptions(window));
  assert.deepEqual(outcome, { kind: 'finished', code: 0 });
  assert.deepEqual(window.screens(), ['welcome', 'check', 'check', 'about', 'options', 'review', 'install', 'done']);
  assert.equal(window.sent[0]?.t, 'init');
  assert.equal(window.sent.at(-1)?.t, 'end');
  assert.equal(window.closed, true);
  const run = world.runner.installRuns[0];
  assert.ok(run !== undefined);
  assert.equal(new TextDecoder().decode(run.stdin), `${PASSWORD}\n`);
  assert.ok(run.args.includes('friend@example.com'));
  assert.equal(world.jobs.firewallOpen, true);
  // Nothing sent to the window, printed, or run as a command holds the password.
  assert.ok(!everythingShown(world, window).includes(PASSWORD));
  // Every copy the window handed over is wiped.
  for (const bytes of window.passwords) {
    assert.ok(bytes.every(byte => byte === 0));
  }
  // Nothing was asked on the terminal.
  assert.deepEqual(world.asked, []);
});

test('the install screen shows each stage as it runs, and the phone stage only when it was chosen', async () => {
  const world = await makeWorld();
  const window = openWindow(person({ phone: false }));
  const outcome = await runWindowInstall(world.deps, sessionOptions(window));
  assert.deepEqual(outcome, { kind: 'finished', code: 0 });
  const install = window.sent.find(
    (message): message is Screen => message.t === 'screen' && message.name === 'install',
  );
  assert.deepEqual(
    install?.rows.map(row => row.id),
    ['download', 'install', 'shortcuts', 'update', 'private', 'open'],
  );
  assert.equal(install?.confirmClose, true);
  const marks = window.sent
    .filter((message): message is Extract<ToWindow, { t: 'row' }> => message.t === 'row')
    .map(message => `${message.id}:${message.mark}`);
  assert.deepEqual(marks.slice(-4), ['private:doing', 'private:done', 'open:doing', 'open:done']);
  assert.equal(world.jobs.firewallOpen, false);
});

test('a window that is not Windows PowerShell in full language mode from the Windows folder is not used', async () => {
  const wrong: FromWindow[] = [
    { ...HELLO, languageMode: 'ConstrainedLanguage' },
    { ...HELLO, modulePath: 'C:\\Users\\Friend\\Downloads\\powershell.exe' },
    { ...HELLO, windowsDir: 'D:\\Windows' },
    { ...HELLO, systemDir: 'C:\\Windows\\SysWOW64' },
    { t: 'next' },
  ];
  for (const hello of wrong) {
    const world = await makeWorld();
    const window = new FakeWindow();
    window.onScreen = person();
    window.say(hello);
    const outcome = await runWindowInstall(world.deps, sessionOptions(window));
    assert.deepEqual(outcome, { kind: 'fallback' });
    assert.deepEqual(window.sent, []);
    assert.equal(window.closed, true);
    assert.equal(world.runner.installRuns.length, 0);
  }
});

test('a window that never says what it is hands over to the terminal', async () => {
  const world = await makeWorld();
  const window = new FakeWindow();
  const outcome = await runWindowInstall(world.deps, sessionOptions(window, { helloWait: () => Promise.resolve() }));
  assert.deepEqual(outcome, { kind: 'fallback' });
  assert.equal(window.closed, true);
});

test('a message the current screen does not allow ends the window and installs nothing', async () => {
  const outOfOrder: { on: string; send: (window: FakeWindow) => void }[] = [
    { on: 'welcome', send: window => window.say({ t: 'options', phone: true }) },
    { on: 'welcome', send: window => window.say({ t: 'about', email: 'friend@example.com' }) },
    { on: 'welcome', send: window => window.type(PASSWORD) },
    { on: 'about', send: window => window.say({ t: 'next' }) },
    { on: 'about', send: window => window.say({ t: 'about', email: 'friend@example.com' }) },
    { on: 'options', send: window => window.say({ t: 'next' }) },
    { on: 'options', send: window => window.type(PASSWORD) },
    { on: 'review', send: window => window.say({ t: 'options', phone: false }) },
    { on: 'review', send: window => window.say(HELLO) },
  ];
  for (const { on, send } of outOfOrder) {
    const world = await makeWorld();
    const forward = person();
    const window = openWindow((screen, fake) => {
      if (screen.name === on && screen.next !== null) {
        send(fake);
      } else {
        forward(screen, fake);
      }
    });
    const outcome = await runWindowInstall(world.deps, sessionOptions(window));
    assert.deepEqual(outcome, { kind: 'fallback' }, on);
    assert.equal(window.closed, true);
    assert.equal(world.runner.installRuns.length, 0);
    assert.ok(!window.screens().includes('install'));
    for (const bytes of window.passwords) {
      assert.ok(
        bytes.every(byte => byte === 0),
        on,
      );
    }
  }
});

test('anything but closing sent while the computer is checked or Aman is installed ends the window', async () => {
  const world = await makeWorld();
  const forward = person();
  const window = openWindow((screen, fake) => {
    if (screen.name === 'check' && screen.next === null) {
      fake.say({ t: 'next' });
    } else {
      forward(screen, fake);
    }
  });
  const outcome = await runWindowInstall(world.deps, sessionOptions(window));
  assert.deepEqual(outcome, { kind: 'fallback' });
  assert.equal(world.runner.installRuns.length, 0);
});

test('passwords that differ, a password that falls short and a bad email are each asked again', async () => {
  const tries: { answers: Person; problem: string }[] = [
    { answers: { again: 'Password2!' }, problem: INSTALL_PASSWORD_MISMATCH_LINE },
    {
      answers: { password: 'short' },
      problem: 'That password still needs at least 8 characters, a number and a symbol, like @ # $ %.',
    },
    { answers: { email: 'not an email' }, problem: WINDOW_EMAIL_PROBLEM },
    { answers: { email: '--yes@example.com' }, problem: WINDOW_EMAIL_PROBLEM },
    { answers: { email: '' }, problem: WINDOW_EMAIL_PROBLEM },
  ];
  for (const { answers, problem } of tries) {
    const world = await makeWorld();
    let first = true;
    const window = openWindow((screen, fake) => {
      if (screen.name === 'about' && first) {
        first = false;
        person(answers)(screen, fake);
        // The person reads the problem and types good answers.
        person()(screen, fake);
      } else {
        person()(screen, fake);
      }
    });
    const outcome = await runWindowInstall(world.deps, sessionOptions(window));
    assert.deepEqual(outcome, { kind: 'finished', code: 0 }, problem);
    assert.deepEqual(window.problems(), [problem]);
    assert.equal(window.screens().filter(name => name === 'about').length, 1);
    const run = world.runner.installRuns[0];
    assert.equal(new TextDecoder().decode(run?.stdin), `${PASSWORD}\n`);
    assert.ok(!everythingShown(world, window).includes('Password2!'));
  }
});

test('going back from Options wipes the password and asks for it again', async () => {
  const world = await makeWorld();
  let wentBack = false;
  const window = openWindow((screen, fake) => {
    if (screen.name === 'options' && !wentBack) {
      wentBack = true;
      fake.say({ t: 'back' });
    } else {
      person()(screen, fake);
    }
  });
  let wipedOnBack = false;
  const original = window.send.bind(window);
  window.send = message => {
    if (message.t === 'screen' && message.name === 'about' && wentBack) {
      wipedOnBack = window.passwords.every(bytes => bytes.every(byte => byte === 0));
    }
    original(message);
  };
  const outcome = await runWindowInstall(world.deps, sessionOptions(window));
  assert.deepEqual(outcome, { kind: 'finished', code: 0 });
  assert.equal(wipedOnBack, true);
  assert.deepEqual(window.screens(), [
    'welcome',
    'check',
    'check',
    'about',
    'options',
    'about',
    'options',
    'review',
    'install',
    'done',
  ]);
});

test('closing the window before the install ends the setup and installs nothing', async () => {
  for (const on of ['welcome', 'check', 'about', 'options', 'review']) {
    const world = await makeWorld();
    const window = openWindow((screen, fake) => {
      if (screen.name === on && screen.next !== null) {
        fake.say({ t: 'closing' });
      } else {
        person()(screen, fake);
      }
    });
    const outcome = await runWindowInstall(world.deps, sessionOptions(window));
    assert.deepEqual(outcome, { kind: 'finished', code: 1 }, on);
    assert.equal(world.printed.at(-1), problemText(WINDOW_CLOSED_EARLY));
    assert.equal(world.runner.installRuns.length, 0);
    for (const bytes of window.passwords) {
      assert.ok(bytes.every(byte => byte === 0));
    }
  }
});

test('a window that is lost before the install hands over to the terminal', async () => {
  const world = await makeWorld();
  const window = openWindow((screen, fake) => {
    if (screen.name === 'about') {
      fake.push({ kind: 'gone' });
    } else {
      person()(screen, fake);
    }
  });
  const outcome = await runWindowInstall(world.deps, sessionOptions(window));
  assert.deepEqual(outcome, { kind: 'fallback' });
  assert.equal(world.runner.installRuns.length, 0);
});

test('bytes that break the rules of the channel end the window', async () => {
  const world = await makeWorld();
  const window = openWindow((screen, fake) => {
    if (screen.name === 'welcome') {
      fake.push({ kind: 'broken' });
    }
  });
  const outcome = await runWindowInstall(world.deps, sessionOptions(window));
  assert.deepEqual(outcome, { kind: 'fallback' });
  assert.equal(window.closed, true);
});

test('closing the window while Aman is installed lets the install run to its end', async () => {
  for (const event of [
    { kind: 'message', message: { t: 'closing' } },
    { kind: 'gone' },
    { kind: 'broken' },
  ] satisfies WindowEvent[]) {
    const world = await makeWorld();
    const window = openWindow((screen, fake) => {
      if (screen.name === 'install') {
        fake.push(event);
      } else {
        person()(screen, fake);
      }
    });
    const outcome = await runWindowInstall(world.deps, sessionOptions(window));
    assert.deepEqual(outcome, { kind: 'finished', code: 0 });
    assert.equal(world.runner.installRuns.length, 1);
    assert.ok(world.printed.includes(WINDOW_CLOSED_LINE));
    assert.equal(world.store.installed, true);
  }
});

test('an install that stops shows what went wrong and ends with its exit code', async () => {
  const world = await makeWorld({ containerExit: 1 });
  const window = openWindow();
  const outcome = await runWindowInstall(world.deps, sessionOptions(window));
  assert.deepEqual(outcome, { kind: 'finished', code: 1 });
  assert.equal(window.screens().at(-1), 'stopped');
  assert.equal(window.problems().length, 1);
  assert.equal(window.problems()[0], world.printed.at(-1));
  for (const bytes of window.passwords) {
    assert.ok(bytes.every(byte => byte === 0));
  }
});

test('a computer that is not ready shows the problem and offers to try again', async () => {
  const world = await makeWorld({ lowMemory: true });
  let tries = 0;
  const window = openWindow((screen, fake) => {
    if (screen.name === 'check' && screen.next !== null) {
      tries += 1;
      assert.equal(screen.next, WINDOW_TRY_AGAIN);
      if (tries === 2) {
        fake.say({ t: 'closing' });
        return;
      }
    }
    person()(screen, fake);
  });
  const outcome = await runWindowInstall(world.deps, sessionOptions(window));
  assert.deepEqual(outcome, { kind: 'finished', code: 1 });
  assert.equal(tries, 2);
  assert.deepEqual(window.problems(), [problemText(LOW_MEMORY.windows), problemText(LOW_MEMORY.windows)]);
  assert.ok(!window.screens().includes('about'));
});

test('a computer that already has Aman closes the window and asks nothing', async () => {
  const world = await makeWorld({ storeInstalled: true });
  const window = openWindow();
  const outcome = await runWindowInstall(world.deps, sessionOptions(window));
  assert.deepEqual(outcome, { kind: 'installed' });
  assert.deepEqual(window.screens(), ['welcome', 'check']);
  assert.equal(window.sent.at(-1)?.t, 'end');
});

test('a run the computer restarted in the middle of opens on the check, not the welcome', async () => {
  const world = await makeWorld({ runOncePending: true });
  const window = openWindow();
  const outcome = await runWindowInstall(world.deps, sessionOptions(window));
  assert.deepEqual(outcome, { kind: 'finished', code: 0 });
  assert.equal(window.screens()[0], 'check');
});

test('a long line from the installer is cut before it is sent to the window', async () => {
  const world = await makeWorld({ containerStdout: `${'x'.repeat(100000)}\n` });
  const window = openWindow();
  await runWindowInstall(world.deps, sessionOptions(window));
  for (const message of window.sent) {
    assert.ok(JSON.stringify(message).length < 60000);
  }
});

test('the install uses the window when one opens and says so on the terminal', async () => {
  const world = await makeWorld();
  const code = await runInstall(world.deps, {
    dryRun: false,
    window: deps => runWindowInstall(deps, sessionOptions(openWindow())),
  });
  assert.equal(code, 0);
  assert.equal(world.printed[0], WINDOW_OPEN_LINE);
  assert.deepEqual(world.asked, []);
});

test('the install asks on the terminal when no window opens or the window is lost', async () => {
  for (const window of [() => Promise.resolve(null), () => Promise.resolve({ kind: 'fallback' } as const)]) {
    const world = await makeWorld();
    const code = await runInstall(world.deps, { dryRun: false, window });
    assert.equal(code, 0);
    assert.ok(world.printed.includes(WINDOW_FALLBACK_LINE));
    assert.equal(world.asked.length, 4);
    assert.equal(world.runner.installRuns.length, 1);
  }
});

test('a dry run opens no window', async () => {
  const world = await makeWorld();
  let opened = false;
  const code = await runInstall(world.deps, {
    dryRun: true,
    window: () => {
      opened = true;
      return Promise.resolve(null);
    },
  });
  assert.equal(code, 0);
  assert.equal(opened, false);
});
