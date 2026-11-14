/**
 * Terminal output style for the scripts, the same look as installer/lib/ui.sh: a boxed banner, numbered steps with a
 * bar, one symbol and one sentence per line, a separator before questions and a boxed verdict.
 * Line methods write to stdout unless taken from `stderr()`; prompts and progress always use stderr.
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

type Verdict = keyof typeof VERDICT_COLOR;
type Target = 'out' | 'err';

interface Symbols {
  ok: string;
  warn: string;
  fail: string;
  prompt: string;
  skip: string;
  rule: string;
  ellipsis: string;
  frames: readonly string[];
  box: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
  barOn: string;
  barOff: string;
}

/** What both streams share: the warnings to repeat, whether a question block is open, and the verdict's color. */
interface UiState {
  /** A step panel is open; its lines get the panel's sides. */
  panel: boolean;
  /** Questions closed the panel; the next other line opens it again. */
  panelResume: boolean;
  /** A blank line inside a panel waits for the next line, so a panel never ends on an empty row. */
  pendingBlank: boolean;
  warnings: string[];
  lastBlank: boolean;
  asking: boolean;
  inPrompt: boolean;
  summaryCode: string;
}

const ASK_LABEL = 'Your answer is needed';

const UTF8_SYMBOLS: Symbols = {
  ok: '✓',
  warn: '!',
  fail: '✗',
  prompt: '›',
  skip: '·',
  rule: '─',
  ellipsis: '…',
  frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'],
  box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  barOn: '━',
  barOff: '─',
};
const ASCII_SYMBOLS: Symbols = {
  ok: '+',
  warn: '!',
  fail: 'x',
  prompt: '>',
  skip: '-',
  rule: '-',
  ellipsis: '...',
  frames: ['|', '/', '-', '\\'],
  box: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
  barOn: '#',
  barOff: '-',
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

/** Columns a line takes on screen: color codes take none and each character takes one. */
function visibleWidth(text: string): number {
  // Each color code is ESC [ digits m, so the text after the code starts after its first "m".
  const [head = '', ...rest] = text.split('\u001b[');
  const plain = head + rest.map(part => part.slice(part.indexOf('m') + 1)).join('');
  return Array.from(plain).length;
}

/** Words wrapped to WIDTH columns; a word longer than that keeps a line of its own. */
function wrapWords({ text, width }: { text: string; width: number }): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(w => w !== '')) {
    if (current === '') {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
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
        const seconds = Math.floor((Date.now() - t0) / 1000);
        let line = `  ${symbol} ${this.text}${seconds >= MIN_SHOWN_SECONDS ? `  ${formatElapsed(seconds)}` : ''}`;
        if (this.note !== '' && line.length + 3 + this.note.length < ui.width) {
          line = `${line}   ${this.note}`;
        }
        // One line never wraps, since a wrapped line cannot be redrawn in place.
        if (line.length >= ui.width) {
          line = `${line.slice(0, ui.width - 4)}${ui.symbols.ellipsis}`;
        }
        ui.writeProgress(`\r${' '.repeat(this.shown)}\r${side}${line}`);
        this.shown = line.length + (side === '' ? 0 : 2);
      };
      // Inside a panel the progress line has the panel's left side.
      const side = ui.progressSide();
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
        this.ui.writeProgress(`\r${' '.repeat(this.ui.fullWidth)}\r`);
      }
    }
  }
}

export class Ui {
  readonly symbols: Symbols;
  /** The width of the screen block; `width` is what text may take, 4 columns less inside a panel. */
  readonly fullWidth: number;
  /** Started by a command while its panel is open, so these lines join that panel instead of opening their own. */
  private readonly framed: boolean;
  readonly animated: boolean;
  private readonly colorOut: boolean;
  private readonly colorErr: boolean;
  private readonly state: UiState;

  constructor(
    private readonly options: UiOptions,
    private readonly target: Target = 'out',
    state?: UiState,
  ) {
    const { env, out, err } = options;
    this.state = state ?? {
      warnings: [],
      lastBlank: true,
      asking: false,
      inPrompt: false,
      summaryCode: COLOR.bold,
      panel: false,
      panelResume: false,
      pendingBlank: false,
    };
    this.framed = env['AMAN_UI_FRAMED'] === '1';
    this.symbols = isUtf8(env) ? UTF8_SYMBOLS : ASCII_SYMBOLS;
    const colorAllowed = (env['NO_COLOR'] ?? '') === '' && env['TERM'] !== 'dumb';
    const forced = env['CLICOLOR_FORCE'] === '1';
    this.colorOut = colorAllowed && (forced || out.isTTY);
    this.colorErr = colorAllowed && (forced || err.isTTY);
    this.animated = err.isTTY && env['TERM'] !== 'dumb';
    const columns = err.isTTY ? (err.columns ?? MAX_WIDTH) : MAX_WIDTH;
    this.fullWidth = err.isTTY ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, columns)) : MAX_WIDTH;
  }

  get width(): number {
    return this.state.panel || this.framed ? this.fullWidth - 4 : this.fullWidth;
  }

  /** The same helpers writing to stderr, for errors and warnings. */
  stderr(): Ui {
    return new Ui(this.options, 'err', this.state);
  }

  get verbose(): boolean {
    return this.options.verbose;
  }

  private get colorOn(): boolean {
    return this.target === 'err' ? this.colorErr : this.colorOut;
  }

  private style({ code, text }: { code: string; text: string }): string {
    return this.colorOn ? `\u001b[${code}m${text}\u001b[0m` : text;
  }

  /**
   * Any line that is not part of a question ends the question block, so the next question gets its separator, and
   * reopens the panel the questions closed. Inside a panel a line gets the panel's sides.
   */
  private emit(line: string): void {
    const { state } = this;
    if (!state.inPrompt) {
      state.asking = false;
      if (state.panelResume) {
        state.panelResume = false;
        this.gap();
        this.panelOpen({ left: '', right: '' });
      }
    }
    if (state.panel || this.framed) {
      state.lastBlank = true;
      if (line === '') {
        state.pendingBlank = true;
        return;
      }
      if (state.pendingBlank) {
        this.raw(this.framedLine(''));
      }
      state.pendingBlank = false;
      state.lastBlank = false;
      this.raw(this.framedLine(line));
      return;
    }
    state.lastBlank = line === '';
    this.raw(line);
  }

  private raw(line: string): void {
    (this.target === 'err' ? this.options.err : this.options.out).write(`${line}\n`);
  }

  /**
   * A line between the two sides of a panel. A line too long for it (a word that cannot break, such as a fingerprint)
   * keeps only the left side, so the word stays whole for copying.
   */
  private framedLine(line: string): string {
    const side = this.style({ code: COLOR.dim, text: this.symbols.box.v });
    const pad = this.fullWidth - 4 - visibleWidth(line);
    return pad < 0 ? `${side} ${line}` : `${side} ${line}${' '.repeat(pad)} ${side}`;
  }

  /** Opens a panel: a top line with LEFT after the corner and RIGHT before the other corner. */
  private panelOpen({ left, right }: { left: string; right: string }): void {
    const { box } = this.symbols;
    this.panelClose();
    const head =
      left === ''
        ? this.style({ code: COLOR.dim, text: box.tl })
        : `${this.style({ code: COLOR.dim, text: `${box.tl}${box.h}` })} ${left} `;
    let tail =
      right === ''
        ? this.style({ code: COLOR.dim, text: box.tr })
        : ` ${right} ${this.style({ code: COLOR.dim, text: `${box.h}${box.tr}` })}`;
    let fill = this.fullWidth - visibleWidth(head) - visibleWidth(tail);
    if (fill < 1 && right !== '') {
      tail = this.style({ code: COLOR.dim, text: box.tr });
      fill = this.fullWidth - visibleWidth(head) - 1;
    }
    this.raw(`${head}${this.style({ code: COLOR.dim, text: box.h.repeat(Math.max(0, fill)) })}${tail}`);
    this.state.panel = true;
    this.state.lastBlank = true;
    this.state.pendingBlank = false;
  }

  /** Closes the open panel with its bottom line; does nothing when none is open. */
  private panelClose(): void {
    const { state } = this;
    state.panelResume = false;
    if (!state.panel) {
      return;
    }
    state.panel = false;
    state.pendingBlank = false;
    const { box } = this.symbols;
    this.raw(this.style({ code: COLOR.dim, text: `${box.bl}${box.h.repeat(this.fullWidth - 2)}${box.br}` }));
    state.lastBlank = false;
  }

  /** Ends the step panel, for a run that stops without its closing block. */
  panelEnd(): void {
    this.panelClose();
  }

  /** The left side a progress line starts with inside a panel; a blank row waiting above it is printed first. */
  progressSide(): string {
    if (!this.state.panel && !this.framed) {
      return '';
    }
    const view = this.stderr();
    if (this.state.pendingBlank) {
      view.raw(view.framedLine(''));
      this.state.pendingBlank = false;
    }
    return `${view.style({ code: COLOR.dim, text: this.symbols.box.v })} `;
  }

  /** One blank line between blocks, never two. */
  private gap(): void {
    if (!this.state.lastBlank) {
      this.emit('');
    }
  }

  /** LEFT, then RIGHT pushed to the right edge; RIGHT is dropped when the two do not fit on one line. */
  private spread({ left, right }: { left: string; right: string }): string {
    const space = this.width - visibleWidth(left) - visibleWidth(right);
    return right === '' || space < 2 ? left : `${left}${' '.repeat(space)}${right}`;
  }

  /** A label that stands out: inverted colors on a terminal, brackets everywhere else. */
  private badge(text: string): string {
    return this.colorOn ? this.style({ code: `7;${COLOR.cyan}`, text: ` ${text} ` }) : `[ ${text} ]`;
  }

  /** A box around short lines of text, as wide as the screen. CODE colors the frame; the lines keep their own styles. */
  private box({ code, lines }: { code: string; lines: readonly string[] }): void {
    const { box } = this.symbols;
    const edge = box.h.repeat(this.fullWidth - 2);
    this.emit(this.style({ code, text: `${box.tl}${edge}${box.tr}` }));
    for (const line of lines) {
      const pad = ' '.repeat(Math.max(0, this.fullWidth - 4 - visibleWidth(line)));
      this.emit(`${this.style({ code, text: box.v })} ${line}${pad} ${this.style({ code, text: box.v })}`);
    }
    this.emit(this.style({ code, text: `${box.bl}${edge}${box.br}` }));
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
    const lines = wrapWords({ text, width: Math.max(20, this.width - leadWidth) });
    lines.forEach((body, index) => {
      const styled = code !== undefined && body !== '' ? this.style({ code, text: body }) : body;
      const last = index === lines.length - 1 ? (tail ?? '') : '';
      this.emit(`${index === 0 ? lead : ' '.repeat(leadWidth)}${styled}${last}`);
    });
  }

  marked({ color, marker, text, tail }: { color: string; marker: string; text: string; tail?: string }): void {
    this.block({ lead: `  ${this.style({ code: color, text: marker })} `, leadWidth: 4, text, tail });
  }

  /** The banner at the top of a run: the name in bold color, then what the run does, in a box. */
  title(text: string): void {
    const name = 'AMAN';
    this.panelClose();
    const lines = wrapWords({ text, width: this.fullWidth - 6 - name.length }).map((line, index) =>
      index === 0
        ? `${this.style({ code: `1;${COLOR.cyan}`, text: name })}  ${line}`
        : `${' '.repeat(name.length + 2)}${line}`,
    );
    this.box({ code: COLOR.cyan, lines });
  }

  /**
   * A step of a run, in a panel of its own: "1 of 6" as a badge and the step in bold in the panel's top line, and how
   * far the run has come as a bar at its right end.
   */
  phase({ text, n, total }: { text: string; n?: number | undefined; total?: number | undefined }): void {
    if (n === undefined) {
      this.openPart({ left: this.badge(text), right: '' });
      return;
    }
    const of = total ?? n;
    const line = `${this.badge(`${String(n)} of ${String(of)}`)}  ${this.style({ code: COLOR.bold, text })}`;
    // With color the part still to come is the same thick line, dimmed; without color it needs a different character.
    const off = this.colorOn ? this.symbols.barOn : this.symbols.barOff;
    const bar = `${this.style({ code: COLOR.green, text: this.symbols.barOn.repeat(2 * n) })}${this.style({
      code: COLOR.dim,
      text: off.repeat(2 * (of - n)),
    })}`;
    this.openPart({ left: line, right: bar });
  }

  /** A panel for a step; inside another command's panel, a heading line, since panels do not nest. */
  private openPart({ left, right }: { left: string; right: string }): void {
    if (this.framed) {
      this.gap();
      this.emit(this.spread({ left, right }));
      return;
    }
    this.panelClose();
    this.gap();
    this.panelOpen({ left, right });
  }

  /** The elapsed time sits at the right edge when the line has room, so the times of a step line up. */
  ok({ text, elapsed }: { text: string; elapsed?: string | undefined }): void {
    if (elapsed === undefined || elapsed === '') {
      this.marked({ color: COLOR.green, marker: this.symbols.ok, text });
      return;
    }
    if (visibleWidth(`  ${this.symbols.ok} ${text}`) + 2 + elapsed.length <= this.width) {
      const left = `  ${this.style({ code: COLOR.green, text: this.symbols.ok })} ${text}`;
      this.emit(this.spread({ left, right: this.style({ code: COLOR.dim, text: elapsed }) }));
      return;
    }
    const tail = `  ${this.style({ code: COLOR.dim, text: elapsed })}`;
    this.marked({ color: COLOR.green, marker: this.symbols.ok, text, tail });
  }

  /** Warnings are remembered so the closing block can repeat them. */
  warn({ text, next, details }: { text: string; next?: string | undefined; details?: string | undefined }): void {
    this.state.warnings.push(text);
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
    this.gap();
    this.emit(this.style({ code: COLOR.bold, text }));
  }

  row({ label, value }: { label: string; value: string }): void {
    this.block({ lead: `  ${label.padEnd(8)}  `, leadWidth: 12, text: value });
  }

  /** A row of the closing table: a marker for its state (`skip` for something left off), the label and the value. */
  checkRow({ state, label, value }: { state: 'ok' | 'todo' | 'warn' | 'skip'; label: string; value: string }): void {
    const marker = {
      ok: { color: COLOR.green, symbol: this.symbols.ok },
      todo: { color: COLOR.cyan, symbol: this.symbols.prompt },
      warn: { color: COLOR.yellow, symbol: this.symbols.warn },
      skip: { color: COLOR.dim, symbol: this.symbols.skip },
    }[state];
    this.block({
      lead: `  ${this.style({ code: marker.color, text: marker.symbol })} ${label.padEnd(8)}  `,
      leadWidth: 14,
      text: value,
    });
  }

  /** Another value under the label of the row above. */
  checkMore(value: string): void {
    this.block({ lead: ' '.repeat(14), leadWidth: 14, text: value });
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

  /**
   * The closing block: the verdict in a box colored by how the run went, then the caller's rows, then `summaryEnd`.
   * Only the verdict is boxed, so the addresses and commands under it copy cleanly.
   */
  summary({ status, verdict }: { status: Verdict; verdict: string }): void {
    const { code, marker } = {
      ok: { code: COLOR.green, marker: this.symbols.ok },
      warn: { code: COLOR.yellow, marker: this.symbols.warn },
      fail: { code: COLOR.red, marker: this.symbols.fail },
    }[status];
    this.state.summaryCode = code;
    this.panelClose();
    const lines = wrapWords({ text: verdict, width: this.fullWidth - 6 }).map((line, index) =>
      index === 0
        ? this.style({ code: VERDICT_COLOR[status], text: `${marker} ${line}` })
        : `  ${this.style({ code: VERDICT_COLOR[status], text: line })}`,
    );
    this.gap();
    this.box({ code, lines });
    this.emit('');
  }

  /** The warnings of the run again, then a closing rule in the verdict's color with the total time at its end. */
  summaryEnd(total?: string): void {
    const { rule } = this.symbols;
    const code = this.state.summaryCode;
    this.panelClose();
    if (this.state.warnings.length > 0) {
      this.gap();
      this.emit(this.style({ code: VERDICT_COLOR.warn, text: 'Warnings' }));
      for (const text of this.state.warnings) {
        this.marked({ color: COLOR.yellow, marker: this.symbols.warn, text });
      }
    }
    this.gap();
    if (total === undefined || total === '') {
      this.emit(this.style({ code, text: rule.repeat(this.fullWidth) }));
      return;
    }
    const end = ` Done in ${total} `;
    this.emit(
      `${this.style({ code, text: rule.repeat(this.fullWidth - end.length - 2) })}${this.style({ code: COLOR.dim, text: end })}${this.style({ code, text: rule.repeat(2) })}`,
    );
  }

  // ---- prompts (stderr) ----

  /**
   * A separator line before a question, so the moment the run waits for a person stands out. Questions in a row share
   * one; any other line in between ends the group, and the next question gets its own separator. Questions stand
   * outside the step's panel, which reopens after them.
   */
  askBegin(): void {
    if (this.state.asking) {
      return;
    }
    const view = this.stderr();
    if (this.state.panel) {
      view.panelClose();
      this.state.panelResume = true;
    }
    view.gap();
    view.emit(
      `${view.style({ code: `1;${COLOR.cyan}`, text: `${this.symbols.prompt} ${ASK_LABEL}` })} ${view.style({
        code: COLOR.dim,
        text: this.symbols.rule.repeat(this.width - ASK_LABEL.length - 3),
      })}`,
    );
    this.state.asking = true;
  }

  /** Text that belongs to the question below it, such as what the question is about, under the separator. */
  askLine(text: string): void {
    this.askBegin();
    this.state.inPrompt = true;
    try {
      this.stderr().line(text);
    } finally {
      this.state.inPrompt = false;
    }
  }

  /** "  > Label [default] " without a newline, as one string; sudo prints its own prompt from such a string. */
  promptText({ label, fallback }: { label: string; fallback?: string | undefined }): string {
    const view = this.stderr();
    const bracket =
      fallback === undefined || fallback === '' ? '' : ` ${view.style({ code: COLOR.dim, text: `[${fallback}]` })}`;
    return `  ${view.style({ code: COLOR.bold, text: this.symbols.prompt })} ${label}${bracket} `;
  }

  promptHead(input: { label: string; fallback?: string | undefined }): void {
    this.options.err.write(this.promptText(input));
  }

  /**
   * Yes or no with the default capitalised. A root or delete question passes 'n'; --yes takes the default and says so.
   * The end of the input counts as no.
   */
  async confirm({ question, fallback }: { question: string; fallback: 'y' | 'n' }): Promise<boolean> {
    this.state.inPrompt = true;
    try {
      return await this.ask({ question, fallback });
    } finally {
      this.state.inPrompt = false;
    }
  }

  private async ask({ question, fallback }: { question: string; fallback: 'y' | 'n' }): Promise<boolean> {
    this.askBegin();
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
