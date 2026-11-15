import { render } from 'ink';
import { Socket } from 'node:net';
import type { ReactElement } from 'react';

/**
 * A small render harness for the terminal components. Ink's stream types are
 * the terminal classes, which need a real terminal device, so these streams
 * are sockets with the data path rerouted in memory and the few terminal
 * members ink reads supplied directly. The input and output paths are the
 * ones the app runs on. (The ink testing library predates this ink version:
 * it renders through a second copy of ink, so its input never reaches these
 * components.)
 */
class TestStdin extends Socket {
  readonly isTTY = true;
  isRaw = false;
  #pending: Buffer[] = [];
  #wantData = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }

  override _read(): void {
    this.#wantData = true;
    this.#flush();
  }

  writeInput(text: string): void {
    this.#pending.push(Buffer.from(text, 'utf8'));
    this.#flush();
  }

  #flush(): void {
    if (!this.#wantData) {
      return;
    }
    const chunk = this.#pending.shift();
    if (chunk === undefined) {
      return;
    }
    this.#wantData = this.push(chunk);
  }
}

class TestStdout extends Socket {
  readonly isTTY = true;
  columns = 100;
  rows = 40;
  #output = '';

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#output += chunk.toString();
    callback();
  }

  get output(): string {
    return this.#output;
  }

  clearLine(_dir: number, callback?: () => void): boolean {
    callback?.();
    return true;
  }

  clearScreenDown(callback?: () => void): boolean {
    callback?.();
    return true;
  }

  cursorTo(_x: number, _y?: number | (() => void), callback?: () => void): boolean {
    (typeof _y === 'function' ? _y : callback)?.();
    return true;
  }

  moveCursor(_dx: number, _dy: number, callback?: () => void): boolean {
    callback?.();
    return true;
  }

  getColorDepth(): number {
    return 1;
  }

  hasColors(): boolean {
    return false;
  }

  getWindowSize(): [number, number] {
    return [this.columns, this.rows];
  }
}

const ANSI_PATTERN = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g');

export interface RenderedApp {
  /** Everything rendered so far, as plain text. */
  text(): string;
  /** Types into the app, as a person at the terminal would. */
  write(input: string): void;
  unmount(): void;
}

export function renderApp(element: ReactElement): RenderedApp {
  const stdin = new TestStdin();
  const stdout = new TestStdout();
  const instance = render(element, {
    stdin,
    stdout,
    stderr: stdout,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    text: () => stdout.output.replace(ANSI_PATTERN, ''),
    write: (input: string) => {
      stdin.writeInput(input);
    },
    unmount: () => {
      instance.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}
