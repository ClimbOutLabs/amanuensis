/**
 * Terminal output style for the scripts: one symbol and one sentence per line, color on markers and verdicts only.
 * Same rendering as installer/lib/ui.sh; installer/tests/ui-fixtures.txt pins both. Line methods write to stdout
 * unless taken from `stderr()`; prompts and progress always use stderr.
 */

export interface UiStream {
  write: (text: string) => void;
  isTTY: boolean;
  columns: number | undefined;
}

export interface UiOptions {
  env: NodeJS.ProcessEnv;
  out: UiStream;
  err: UiStream;
  /** One line of input, or undefined at the end of the input. */
  readLine: () => Promise<string | undefined>;
  verbose: boolean;
  assumeYes: boolean;
}

const MAX_WIDTH = 72;
const MIN_WIDTH = 40;
const STATUS_WIDTH = 11;
const STATUS_TEXT_COLUMN = STATUS_WIDTH + 6;
const MAX_TRIES = 5;
const TICK_MS = 60_000;
const FRAME_MS = 200;
const MIN_SHOWN_SECONDS = 5;

const COLOR = { green: '32', yellow: '33', red: '31', cyan: '36', bold: '1', dim: '2' } as const;
const VERDICT_COLOR = { ok: '1;32', warn: '1;33', fail: '1;31' } as const;

export type Verdict = keyof typeof VERDICT_COLOR;
type Target = 'out' | 'err';

interface Symbols {
  ok: string;
  warn: string;
  fail: string;
  prompt: string;
  skip: string;
  rule: string;
  frames: readonly string[];
}

const UTF8_SYMBOLS: Symbols = {
  ok: '✓',
  warn: '!',
  fail: '✗',
  prompt: '›',
  skip: '·',
  rule: '─',
  frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'],
};
const ASCII_SYMBOLS: Symbols = {
  ok: '+',
  warn: '!',
  fail: 'x',
  prompt: '>',
  skip: '-',
  rule: '-',
  frames: ['|', '/', '-', '\\'],
};

/** 9s, 2m 05s, 1h 02m. */
export function formatElapsed(seconds: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (seconds >= 3600) {
    return `${String(Math.floor(seconds / 3600))}h ${pad(Math.floor((seconds % 3600) / 60))}m`;
  }
  if (seconds >= 60) {
    return `${String(Math.floor(seconds / 60))}m ${pad(seconds % 60)}s`;
  }
  return `${String(seconds)}s`;
}

/** Shows the home directory as ~. */
export function tildify({ path, home }: { path: string; home: string | undefined }): string {
  if (home === undefined || home === '') {
    return path;
  }
  if (path === home) {
    return '~';
  }
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function isUtf8(env: NodeJS.ProcessEnv): boolean {
  const locale = [env['LC_ALL'], env['LC_CTYPE'], env['LANG']].find(value => value !== undefined && value !== '');
  return env['TERM'] !== 'dumb' && /utf-?8/i.test(locale ?? '');
}

export class UiStep {
  private timer: NodeJS.Timeout | undefined;
  private shown = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly ui: Ui,
    private readonly text: string,
    private readonly note: string,
  ) {}

  start(): void {
    const { ui } = this;
    const t0 = this.startedAt;
    if (ui.animated) {
      let frame = 0;
      const draw = (): void => {
        const symbol = ui.symbols.frames[frame % ui.symbols.frames.length] ?? '';
        frame += 1;
        let line = `  ${symbol} ${this.text}  ${formatElapsed(Math.floor((Date.now() - t0) / 1000))}`;
        if (this.note !== '' && line.length + 3 + this.note.length < ui.width) {
          line = `${line}   ${this.note}`;
        }
        ui.writeProgress(`\r${' '.repeat(this.shown)}\r${line}`);
        this.shown = line.length;
      };
      draw();
      this.timer = setInterval(draw, FRAME_MS);
    } else {
      ui.stderr().marked({
        color: COLOR.cyan,
        marker: ui.symbols.prompt,
        text: this.note === '' ? this.text : `${this.text}  ${this.note}`,
      });
      let minutes = 0;
      this.timer = setInterval(() => {
        minutes += 1;
        ui.stderr().block({ lead: '    ', leadWidth: 4, text: `still working, ${String(minutes)}m`, code: COLOR.dim });
      }, TICK_MS);
    }
  }

  /** Replaces the progress line with the result line. */
  end({ status, text, next, details }: { status: 'ok' | 'fail'; text: string; next?: string; details?: string }): void {
    this.stop();
    if (status === 'ok') {
      const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
      this.ui.ok({ text, elapsed: seconds >= MIN_SHOWN_SECONDS ? formatElapsed(seconds) : undefined });
    } else {
      this.ui.fail({ text, next, details });
    }
  }

  /** Stops the progress line without a result. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
      if (this.ui.animated) {
        this.ui.writeProgress(`\r${' '.repeat(this.ui.width)}\r`);
      }
    }
  }
}

export class Ui {
  readonly symbols: Symbols;
  readonly width: number;
  readonly animated: boolean;
  private readonly colorOut: boolean;
  private readonly colorErr: boolean;
  private readonly warnings: string[];

  constructor(
    private readonly options: UiOptions,
    private readonly target: Target = 'out',
    warnings: string[] = [],
  ) {
    const { env, out, err } = options;
    this.warnings = warnings;
    this.symbols = isUtf8(env) ? UTF8_SYMBOLS : ASCII_SYMBOLS;
    const colorAllowed = (env['NO_COLOR'] ?? '') === '' && env['TERM'] !== 'dumb';
    const forced = env['CLICOLOR_FORCE'] === '1';
    this.colorOut = colorAllowed && (forced || out.isTTY);
    this.colorErr = colorAllowed && (forced || err.isTTY);
    this.animated = err.isTTY && env['TERM'] !== 'dumb';
    const columns = err.isTTY ? (err.columns ?? MAX_WIDTH) : MAX_WIDTH;
    this.width = err.isTTY ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, columns)) : MAX_WIDTH;
  }

  /** The same helpers writing to stderr, for errors and warnings. */
  stderr(): Ui {
    return new Ui(this.options, 'err', this.warnings);
  }

  get verbose(): boolean {
    return this.options.verbose;
  }

  private style({ code, text }: { code: string; text: string }): string {
    const on = this.target === 'err' ? this.colorErr : this.colorOut;
    return on ? `\u001b[${code}m${text}\u001b[0m` : text;
  }

  private emit(line: string): void {
    (this.target === 'err' ? this.options.err : this.options.out).write(`${line}\n`);
  }

  writeProgress(text: string): void {
    this.options.err.write(text);
  }

  /** One wrapped block: LEAD starts the first line (leadWidth columns), later lines are indented to match. */
  block({
    lead,
    leadWidth,
    text,
    code,
    tail,
  }: {
    lead: string;
    leadWidth: number;
    text: string;
    code?: string | undefined;
    tail?: string | undefined;
  }): void {
    const avail = Math.max(20, this.width - leadWidth);
    const lines: string[] = [];
    let current = '';
    for (const word of text.split(/\s+/).filter(w => w !== '')) {
      if (current === '') {
        current = word;
      } else if (current.length + 1 + word.length <= avail) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
    lines.forEach((body, index) => {
      const styled = code !== undefined && body !== '' ? this.style({ code, text: body }) : body;
      const last = index === lines.length - 1 ? (tail ?? '') : '';
      this.emit(`${index === 0 ? lead : ' '.repeat(leadWidth)}${styled}${last}`);
    });
  }

  marked({ color, marker, text, tail }: { color: string; marker: string; text: string; tail?: string }): void {
    this.block({ lead: `  ${this.style({ code: color, text: marker })} `, leadWidth: 4, text, tail });
  }

  title(text: string): void {
    this.emit(this.style({ code: COLOR.bold, text }));
  }

  phase({ text, n, total }: { text: string; n?: number | undefined; total?: number | undefined }): void {
    this.emit('');
    const counter =
      n === undefined ? '' : ` ${this.style({ code: COLOR.dim, text: `(${String(n)} of ${String(total ?? n)})` })}`;
    this.emit(`${this.style({ code: COLOR.bold, text })}${counter}`);
  }

  ok({ text, elapsed }: { text: string; elapsed?: string | undefined }): void {
    const tail = elapsed === undefined || elapsed === '' ? '' : `  ${this.style({ code: COLOR.dim, text: elapsed })}`;
    this.marked({ color: COLOR.green, marker: this.symbols.ok, text, tail });
  }

  /** Warnings are remembered so the closing block can repeat them. */
  warn({ text, next, details }: { text: string; next?: string | undefined; details?: string | undefined }): void {
    this.warnings.push(text);
    this.marked({ color: COLOR.yellow, marker: this.symbols.warn, text });
    this.follow({ next, details });
  }

  fail({ text, next, details }: { text: string; next?: string | undefined; details?: string | undefined }): void {
    this.marked({ color: COLOR.red, marker: this.symbols.fail, text });
    this.follow({ next, details });
  }

  /** The Next: and Details: lines under a warning or a failure; technical details wait for --verbose. */
  private follow({ next, details }: { next: string | undefined; details: string | undefined }): void {
    if (next !== undefined && next !== '') {
      this.block({ lead: '    Next: ', leadWidth: 10, text: next });
    }
    if (details !== undefined && details !== '') {
      this.block({
        lead: `    ${this.style({ code: COLOR.dim, text: 'Details:' })} `,
        leadWidth: 13,
        text: this.options.verbose ? details : '--verbose',
        code: COLOR.dim,
      });
    }
  }

  skip(text: string): void {
    this.block({ lead: `  ${this.symbols.skip} `, leadWidth: 4, text, code: COLOR.dim });
  }

  hint(text: string): void {
    this.block({ lead: '  ', leadWidth: 2, text, code: COLOR.dim });
  }

  line(text: string): void {
    this.block({ lead: '  ', leadWidth: 2, text });
  }

  heading(text: string): void {
    this.emit('');
    this.emit(this.style({ code: COLOR.bold, text }));
  }

  row({ label, value }: { label: string; value: string }): void {
    this.block({ lead: `  ${label.padEnd(8)}  `, leadWidth: 12, text: value });
  }

  rule(): void {
    this.emit(this.style({ code: COLOR.dim, text: this.symbols.rule.repeat(this.width) }));
  }

  newline(): void {
    this.emit('');
  }

  private status({ color, marker, word, text }: { color: string; marker: string; word: string; text: string }): void {
    const pad = ' '.repeat(STATUS_WIDTH - word.length + 2);
    this.block({
      lead: `  ${this.style({ code: color, text: marker })} ${this.style({ code: color, text: word })}${pad}`,
      leadWidth: STATUS_TEXT_COLUMN,
      text,
    });
  }

  done(text: string): void {
    this.status({ color: COLOR.green, marker: this.symbols.ok, word: 'done', text });
  }

  todo(text: string): void {
    this.status({ color: COLOR.cyan, marker: this.symbols.prompt, word: 'to do', text });
  }

  admin(text: string): void {
    this.status({ color: COLOR.yellow, marker: this.symbols.warn, word: 'needs admin', text });
  }

  /** Dim detail lines under a plan row, in its text column. */
  detail(text: string): void {
    this.block({ lead: ' '.repeat(STATUS_TEXT_COLUMN), leadWidth: STATUS_TEXT_COLUMN, text, code: COLOR.dim });
  }

  /** A framed closing block: rule, the verdict, then the caller's rows, then `summaryEnd`. */
  summary({ status, verdict }: { status: Verdict; verdict: string }): void {
    this.emit('');
    this.rule();
    this.block({ lead: '', leadWidth: 0, text: verdict, code: VERDICT_COLOR[status] });
    this.emit('');
  }

  summaryEnd(total?: string): void {
    if (this.warnings.length > 0) {
      this.heading('Warnings');
      for (const text of this.warnings) {
        this.marked({ color: COLOR.yellow, marker: this.symbols.warn, text });
      }
    }
    if (total !== undefined && total !== '') {
      this.emit('');
      this.emit(this.style({ code: COLOR.dim, text: `Done in ${total}` }));
    }
    this.rule();
  }

  // ---- prompts (stderr) ----

  /** "  > Label [default] " without a newline. */
  promptHead({ label, fallback }: { label: string; fallback?: string | undefined }): void {
    const view = this.stderr();
    const bracket =
      fallback === undefined || fallback === '' ? '' : ` ${view.style({ code: COLOR.dim, text: `[${fallback}]` })}`;
    this.options.err.write(`  ${view.style({ code: COLOR.bold, text: this.symbols.prompt })} ${label}${bracket} `);
  }

  /**
   * Yes or no with the default capitalised. A root or delete question passes 'n'; --yes takes the default and says so.
   * The end of the input counts as no.
   */
  async confirm({ question, fallback }: { question: string; fallback: 'y' | 'n' }): Promise<boolean> {
    const choices = fallback === 'y' ? 'Y/n' : 'y/N';
    const label = `${question} [${choices}]`;
    if (this.options.assumeYes) {
      this.promptHead({ label });
      this.options.err.write(fallback === 'y' ? 'yes (--yes)\n' : 'no (--yes)\n');
      return fallback === 'y';
    }
    for (let tries = 0; tries < MAX_TRIES; tries += 1) {
      this.promptHead({ label });
      const answer = await this.options.readLine();
      if (answer === undefined) {
        this.options.err.write('\n');
        return false;
      }
      const normal = answer.trim().toLowerCase();
      if (normal === 'y' || normal === 'yes') {
        return true;
      }
      if (normal === 'n' || normal === 'no') {
        return false;
      }
      if (normal === '') {
        return fallback === 'y';
      }
      this.stderr().fail({ text: 'Please answer yes or no.' });
    }
    return false;
  }

  /** One progress line for a long step; the tool's own output belongs in the log file. */
  step({ text, logFile }: { text: string; logFile?: string | undefined }): UiStep {
    const note = logFile === undefined ? '' : `log: ${tildify({ path: logFile, home: this.options.env['HOME'] })}`;
    const step = new UiStep(this, text, note);
    step.start();
    return step;
  }
}

export function createUi(options: UiOptions): Ui {
  return new Ui(options);
}
