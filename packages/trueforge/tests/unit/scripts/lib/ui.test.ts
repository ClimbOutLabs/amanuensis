import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createUi, formatElapsed, tildify, type Ui, type UiOptions } from '../../../../scripts/lib/ui';

const FIXTURES = resolve(__dirname, '../../../../../../installer/tests/ui-fixtures.txt');
const MODES = ['color', 'nocolor', 'plain', 'ascii'] as const;
type Mode = (typeof MODES)[number];

const MODE_ENV: Record<Mode, NodeJS.ProcessEnv> = {
  color: { LANG: 'C.UTF-8', CLICOLOR_FORCE: '1', TERM: 'xterm' },
  nocolor: { LANG: 'C.UTF-8', CLICOLOR_FORCE: '1', NO_COLOR: '1', TERM: 'xterm' },
  plain: { LANG: 'C.UTF-8', TERM: 'xterm' },
  ascii: { LANG: 'C', TERM: 'xterm' },
};

/** Positional fixture arguments to the option names of the Node method; a name list means one options object. */
const PARAMS: Record<string, readonly string[]> = {
  ui_phase: ['text', 'n', 'total'],
  ui_ok: ['text', 'elapsed'],
  ui_warn: ['text', 'next', 'details'],
  ui_fail: ['text', 'next', 'details'],
  ui_row: ['label', 'value'],
  ui_check_row: ['state', 'label', 'value'],
  ui_summary: ['status', 'verdict'],
  ui_prompt_head: ['label', 'fallback'],
  ui_confirm: ['question', 'fallback'],
};

type Arg = string | number;

interface FixtureCase {
  name: string;
  verbose: boolean;
  assumeYes: boolean;
  calls: { name: string; args: Arg[] }[];
  expected: Record<string, string>;
}

/** Bare digits are numbers, quoted words are text, as the shell fixture reads them. */
function tokenize(line: string): { name: string; args: Arg[] } {
  const tokens = [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)];
  const [first, ...rest] = tokens;
  return {
    name: first?.[2] ?? '',
    args: rest.map(token =>
      token[1] !== undefined ? token[1] : /^\d+$/.test(token[2] ?? '') ? Number(token[2]) : (token[2] ?? ''),
    ),
  };
}

function parseFixtures(): FixtureCase[] {
  const cases: FixtureCase[] = [];
  let current: FixtureCase | undefined;
  let mode: string | undefined;
  let body: string[] = [];
  const commit = (): void => {
    if (current !== undefined && mode !== undefined) {
      while (body.length > 0 && body[body.length - 1] === '') {
        body.pop();
      }
      current.expected[mode] = body.join('\n');
    }
    mode = undefined;
    body = [];
  };
  for (const line of readFileSync(FIXTURES, 'utf8').split('\n')) {
    if (line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('== ')) {
      commit();
      current = { name: line.slice(3), verbose: false, assumeYes: false, calls: [], expected: {} };
      cases.push(current);
    } else if (line === 'set verbose 1') {
      if (current !== undefined) current.verbose = true;
    } else if (line === 'set assume_yes 1') {
      if (current !== undefined) current.assumeYes = true;
    } else if (line.startsWith('call ') && mode === undefined) {
      current?.calls.push(tokenize(line.slice(5)));
    } else if (line.startsWith('-- ')) {
      commit();
      mode = line.slice(3);
    } else if (mode !== undefined) {
      body.push(line);
    }
  }
  commit();
  return cases;
}

function withNamedArgs({ method, args }: { method: string; args: Arg[] }): unknown {
  const names = PARAMS[method];
  if (names === undefined) {
    return args[0];
  }
  return Object.fromEntries(names.flatMap((name, index) => (args[index] === undefined ? [] : [[name, args[index]]])));
}

function camel(name: string): string {
  return name.replace(/^ui_/, '').replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

async function render({ fixture, mode }: { fixture: FixtureCase; mode: Mode }): Promise<string> {
  let output = '';
  const sink = { write: (text: string): void => void (output += text), isTTY: false, columns: undefined };
  const options: UiOptions = {
    env: MODE_ENV[mode],
    out: sink,
    err: sink,
    readLine: () => Promise.resolve(undefined),
    verbose: fixture.verbose,
    assumeYes: fixture.assumeYes,
  };
  const ui = createUi(options);
  for (const call of fixture.calls) {
    const method = camel(call.name);
    const fn: unknown = Reflect.get(ui, method);
    if (typeof fn !== 'function') {
      throw new Error(`fixture calls ${call.name}, which Ui lacks`);
    }
    const argument = withNamedArgs({ method: call.name, args: call.args });
    await Reflect.apply(fn, ui, argument === undefined ? [] : [argument]);
  }
  return output.replace(/\u001b/g, '\\e').replace(/\n+$/, '');
}

describe('terminal style fixtures shared with installer/lib/ui.sh', () => {
  const cases = parseFixtures();

  it('reads every case with all four modes', () => {
    expect(cases.length).toBeGreaterThan(5);
    for (const fixture of cases) {
      expect(Object.keys(fixture.expected).sort()).toEqual([...MODES].sort());
    }
  });

  for (const fixture of parseFixtures()) {
    for (const mode of MODES) {
      it(`${fixture.name} (${mode})`, async () => {
        expect(await render({ fixture, mode })).toBe(fixture.expected[mode]);
      });
    }
  }
});

describe('helpers', () => {
  it('formats elapsed time', () => {
    expect([9, 125, 760, 3720].map(formatElapsed)).toEqual(['9s', '2m 05s', '12m 40s', '1h 02m']);
  });

  it('shows the home directory as a tilde', () => {
    expect(tildify({ path: '/home/me/.amanuensis/x', home: '/home/me' })).toBe('~/.amanuensis/x');
    expect(tildify({ path: '/var/x', home: '/home/me' })).toBe('/var/x');
  });
});

describe('prompts', () => {
  const collect = ({ assumeYes }: { assumeYes: boolean }): { ui: Ui; output: () => string } => {
    let output = '';
    const sink = { write: (text: string): void => void (output += text), isTTY: false, columns: 100 };
    const ui = createUi({
      env: { LANG: 'C.UTF-8', TERM: 'xterm', NO_COLOR: '1' },
      out: sink,
      err: sink,
      readLine: () => Promise.resolve(undefined),
      verbose: false,
      assumeYes,
    });
    return { ui, output: () => output };
  };

  it('ends a prompt with a colon and a space, after the default when there is one', () => {
    const { ui } = collect({ assumeYes: false });
    expect(ui.promptText({ label: 'Your name' })).toBe('  › Your name: ');
    expect(ui.promptText({ label: 'Your name', fallback: 'main' })).toBe('  › Your name [main]: ');
  });

  it('asks a yes or no question the same way, also when --yes answers it', async () => {
    const { ui, output } = collect({ assumeYes: true });
    expect(await ui.confirm({ question: 'Create the sandbox disks?', fallback: 'n' })).toBe(false);
    expect(output()).toContain('Create the sandbox disks? [y/N]: ');
  });
});

describe('progress lines', () => {
  const collect = (tty: boolean): { ui: Ui; output: () => string } => {
    let output = '';
    const sink = { write: (text: string): void => void (output += text), isTTY: tty, columns: 100 };
    const ui = createUi({
      env: { LANG: 'C.UTF-8', TERM: 'xterm', NO_COLOR: '1' },
      out: sink,
      err: sink,
      readLine: () => Promise.resolve(undefined),
      verbose: false,
      assumeYes: false,
    });
    return { ui, output: () => output };
  };

  it('prints a start line and one result line without a terminal', () => {
    const { ui, output } = collect(false);
    const step = ui.step({ text: 'Building the app image', logFile: '/tmp/build.log' });
    step.end({ status: 'ok', text: 'Built the app image' });
    expect(output()).toBe('  › Building the app image log: /tmp/build.log\n  ✓ Built the app image\n');
    expect(output()).not.toContain('\r');
  });

  it('rewrites one line in place on a terminal and ends with a result line', () => {
    const { ui, output } = collect(true);
    const step = ui.step({ text: 'Building the app image' });
    step.end({ status: 'fail', text: 'The app image could not be built', next: 'Run it again' });
    expect(output()).toContain('\r');
    expect(output()).toContain('✗ The app image could not be built');
    expect(output()).toContain('Next: Run it again');
  });
});
