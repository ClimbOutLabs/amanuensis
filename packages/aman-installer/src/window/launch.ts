import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

import { encodeFrame, FRAME_MESSAGE, FRAME_PASSWORD, FrameReader } from './frames.ts';
import { encodeToWindow, parseFromWindow, type ToWindow } from './protocol.ts';
import type { WindowChannel, WindowEvent } from './session.ts';
import { WINDOW_BOOTSTRAP, WINDOW_SCRIPT } from './windowScript.ts';

// The two ends of the window's process the channel uses, as Node
// hands them over. A test stands in its own.
export interface WindowProcess {
  write: (bytes: Uint8Array) => void;
  onData: (listener: (chunk: Uint8Array) => void) => void;
  onEnd: (listener: () => void) => void;
  kill: () => void;
}

export interface WindowLaunch {
  channel: WindowChannel;
  powershellPath: string;
  windowsDir: string;
  // Resolves when the window has had long enough to open and say
  // what it is.
  helloWait: () => Promise<void>;
}

const HELLO_WAIT_MS = 30000;

// The fixed words PowerShell is started with. No profile is loaded,
// PowerShell leaves standard input to the script, and nothing here
// changes with what a person types or with what is on the computer.
export const WINDOW_POWERSHELL_ARGS: readonly string[] = [
  '-NoProfile',
  '-NoLogo',
  '-NonInteractive',
  '-InputFormat',
  'None',
  '-Command',
  WINDOW_BOOTSTRAP,
];

// Where Windows PowerShell lives, from the Windows folder the system
// names. Only a plain folder on a lettered drive is taken: a network
// path or one with a step back in it is refused, so the program that
// is started is the one inside the Windows folder and no other. This
// is the check that carries the weight; the window's own word about
// where it runs, compared later, catches a mistake, not an attacker
// who already runs as this person.
export function powershellLocation(systemRoot: string | undefined): { windowsDir: string; path: string } | null {
  if (systemRoot === undefined || !/^[A-Za-z]:\\[^<>:"|?*/]*$/.test(systemRoot)) {
    return null;
  }
  const parts = systemRoot.split('\\');
  if (parts.some(part => part === '.' || part === '..')) {
    return null;
  }
  const windowsDir = systemRoot.replace(/\\+$/, '');
  return { windowsDir, path: win32.join(windowsDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') };
}

// What the window's process is given of this program's environment:
// the names Windows itself sets for where things are, and nothing a
// person or another program may have added.
const ENVIRONMENT_NAMES: readonly string[] = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'COMPUTERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'PUBLIC',
  'SESSIONNAME',
  'SystemDrive',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
];

export function windowEnvironment(options: {
  env: Readonly<Record<string, string | undefined>>;
  windowsDir: string;
}): Record<string, string> {
  const system32 = win32.join(options.windowsDir, 'System32');
  const result: Record<string, string> = {
    SystemRoot: options.windowsDir,
    windir: options.windowsDir,
    PATH: [system32, options.windowsDir, win32.join(system32, 'Wbem')].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  };
  const wanted = new Map(ENVIRONMENT_NAMES.map(name => [name.toLowerCase(), name]));
  for (const [name, value] of Object.entries(options.env)) {
    const known = wanted.get(name.toLowerCase());
    if (known !== undefined && value !== undefined) {
      result[known] = value;
    }
  }
  return result;
}

// The channel over the window's process: frames out, frames in. The
// script goes first, behind its length. A frame or a message that
// breaks the rules ends the reading, and the session is told once.
export function channelOver(process: WindowProcess): WindowChannel {
  const reader = new FrameReader();
  const queue: WindowEvent[] = [];
  const waiting: ((event: WindowEvent) => void)[] = [];
  let over: 'gone' | 'broken' | null = null;
  let closed = false;

  const deliver = (event: WindowEvent): void => {
    const waiter = waiting.shift();
    if (waiter === undefined) {
      queue.push(event);
    } else {
      waiter(event);
    }
  };
  const finish = (how: 'gone' | 'broken'): void => {
    if (over !== null) {
      return;
    }
    over = how;
    reader.clear();
    deliver({ kind: how });
  };

  process.onData(chunk => {
    if (over !== null) {
      chunk.fill(0);
      return;
    }
    try {
      for (const frame of reader.push(chunk)) {
        if (frame.kind === FRAME_PASSWORD) {
          deliver({ kind: 'password', bytes: frame.payload });
        } else {
          deliver({ kind: 'message', message: parseFromWindow(frame.payload) });
        }
      }
    } catch {
      finish('broken');
    } finally {
      // The chunk may hold a password frame. The reader has its own
      // copy to hand over, so this one is wiped at once.
      chunk.fill(0);
    }
  });
  process.onEnd(() => {
    finish('gone');
  });

  const script = new TextEncoder().encode(WINDOW_SCRIPT);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, script.length, false);
  process.write(length);
  process.write(script);

  return {
    send: (message: ToWindow) => {
      if (over === null && !closed) {
        process.write(encodeFrame({ kind: FRAME_MESSAGE, payload: encodeToWindow(message) }));
      }
    },
    next: () => {
      const queued = queue.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      if (over !== null) {
        return Promise.resolve({ kind: over });
      }
      return new Promise<WindowEvent>(resolve => {
        waiting.push(resolve);
      });
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const event of queue) {
        if (event.kind === 'password') {
          event.bytes.fill(0);
        }
      }
      queue.length = 0;
      finish('gone');
      process.kill();
    },
  };
}

// Starts the setup window on this computer, or answers null when it
// cannot be started here. The window's process is given the Windows
// system folder to work in, so nothing beside the downloaded program
// is picked up, and only its input and output are joined to this
// program: no file, no port and no name another program could reach.
export function openSetupWindow(options: {
  systemRoot: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
}): WindowLaunch | null {
  const location = powershellLocation(options.systemRoot);
  if (location === null || !existsSync(location.path)) {
    return null;
  }
  const child = spawn(location.path, [...WINDOW_POWERSHELL_ARGS], {
    cwd: win32.join(location.windowsDir, 'System32'),
    env: windowEnvironment({ env: options.env, windowsDir: location.windowsDir }),
    stdio: ['pipe', 'pipe', 'ignore'],
    shell: false,
    // Not hidden: Windows would hide the setup window with it.
    windowsHide: false,
  });
  let ended = false;
  const endListeners: (() => void)[] = [];
  const onEnded = (): void => {
    if (!ended) {
      ended = true;
      for (const listener of endListeners) {
        listener();
      }
    }
  };
  child.on('error', onEnded);
  child.on('close', onEnded);
  child.stdin.on('error', () => {
    // The window ended before reading; its close is what is acted on.
  });
  const channel = channelOver({
    write: bytes => {
      if (!ended) {
        child.stdin.write(bytes);
      }
    },
    onData: listener => {
      child.stdout.on('data', (chunk: Buffer) => {
        listener(chunk);
      });
    },
    onEnd: listener => {
      endListeners.push(listener);
    },
    kill: () => {
      child.stdin.end();
      child.kill();
    },
  });
  return {
    channel,
    powershellPath: location.path,
    windowsDir: location.windowsDir,
    helloWait: () =>
      new Promise<void>(resolve => {
        // Not held open for: a setup that ends sooner leaves at once.
        setTimeout(resolve, HELLO_WAIT_MS).unref();
      }),
  };
}
