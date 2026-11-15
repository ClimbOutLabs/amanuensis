import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeFrame, FRAME_MESSAGE, FRAME_PASSWORD, FrameReader } from '../../src/window/frames.ts';
import {
  channelOver,
  openSetupWindow,
  powershellLocation,
  windowEnvironment,
  type WindowProcess,
} from '../../src/window/launch.ts';
import { WINDOW_SCRIPT } from '../../src/window/windowScript.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

class FakeProcess implements WindowProcess {
  written: Uint8Array[] = [];
  killed = 0;
  private data: ((chunk: Uint8Array) => void) | null = null;
  private end: (() => void) | null = null;

  write(chunk: Uint8Array): void {
    this.written.push(chunk);
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.data = listener;
  }

  onEnd(listener: () => void): void {
    this.end = listener;
  }

  kill(): void {
    this.killed += 1;
  }

  emit(chunk: Uint8Array): void {
    this.data?.(chunk);
  }

  exit(): void {
    this.end?.();
  }
}

test('Windows PowerShell is found only inside a plain Windows folder on a lettered drive', () => {
  assert.deepEqual(powershellLocation('C:\\Windows'), {
    windowsDir: 'C:\\Windows',
    path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  });
  assert.deepEqual(powershellLocation('D:\\WINNT\\'), {
    windowsDir: 'D:\\WINNT',
    path: 'D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  });
  const refused = [
    undefined,
    '',
    'Windows',
    '.\\Windows',
    '\\Windows',
    '\\\\server\\share\\Windows',
    '\\\\?\\C:\\Windows',
    'C:Windows',
    'C:\\Windows\\..\\Users\\Friend\\Downloads',
    'C:\\Users\\Friend\\.\\Downloads',
    'C:/Windows',
    'C:\\Windows;D:\\Other',
    'C:\\Win"dows',
    'C:\\Windows:stream',
    'https://example.com/Windows',
  ];
  for (const root of refused) {
    assert.equal(powershellLocation(root), null, String(root));
  }
});

test('no window is opened when the Windows folder is not named or PowerShell is not in it', () => {
  assert.equal(openSetupWindow({ systemRoot: undefined, env: {} }), null);
  assert.equal(openSetupWindow({ systemRoot: 'Z:\\No Such Windows Folder', env: {} }), null);
});

test('the window is given only the names Windows itself sets, and its search path is the Windows folders', () => {
  const env = windowEnvironment({
    env: {
      SystemRoot: 'D:\\Elsewhere',
      windir: 'D:\\Elsewhere',
      Path: 'C:\\Users\\Friend\\Downloads;C:\\Windows\\System32',
      PSModulePath: 'C:\\Users\\Friend\\Downloads\\Modules',
      PSExecutionPolicyPreference: 'Bypass',
      COMPLUS_Version: 'v2.0',
      NODE_OPTIONS: '--inspect',
      AMAN_SECRET: 'never',
      localappdata: 'C:\\Users\\Friend\\AppData\\Local',
      TEMP: 'C:\\Users\\Friend\\AppData\\Local\\Temp',
      USERPROFILE: undefined,
    },
    windowsDir: 'C:\\Windows',
  });
  assert.deepEqual(env, {
    SystemRoot: 'C:\\Windows',
    windir: 'C:\\Windows',
    PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    LOCALAPPDATA: 'C:\\Users\\Friend\\AppData\\Local',
    TEMP: 'C:\\Users\\Friend\\AppData\\Local\\Temp',
  });
});

test('the script is sent first, behind its length, and messages follow as frames', async () => {
  const process = new FakeProcess();
  const channel = channelOver(process);
  assert.equal(process.written.length, 2);
  const script = bytes(WINDOW_SCRIPT);
  assert.equal(new DataView(process.written[0]?.buffer ?? new ArrayBuffer(4)).getUint32(0, false), script.length);
  assert.deepEqual(process.written[1], script);

  channel.send({ t: 'problem', text: 'x' });
  const frames = new FrameReader().push(process.written[2] ?? new Uint8Array());
  assert.equal(frames[0]?.kind, FRAME_MESSAGE);
  assert.equal(new TextDecoder().decode(frames[0]?.payload), '{"t":"problem","text":"x"}');

  process.emit(encodeFrame({ kind: FRAME_MESSAGE, payload: bytes('{"t":"next"}') }));
  process.emit(encodeFrame({ kind: FRAME_PASSWORD, payload: bytes('Password1!') }));
  assert.deepEqual(await channel.next(), { kind: 'message', message: { t: 'next' } });
  const password = await channel.next();
  assert.equal(password.kind, 'password');
  const waiting = channel.next();
  process.exit();
  assert.deepEqual(await waiting, { kind: 'gone' });
  assert.deepEqual(await channel.next(), { kind: 'gone' });
});

test('a frame or a message that breaks the rules ends the reading, and nothing after it is taken', async () => {
  for (const bad of [
    new Uint8Array([0x09, 0, 0, 0, 0]),
    encodeFrame({ kind: FRAME_MESSAGE, payload: bytes('{"t":"run","command":"calc.exe"}') }),
    bytes('{"t":"next"}\n'),
  ]) {
    const process = new FakeProcess();
    const channel = channelOver(process);
    process.emit(bad);
    process.emit(encodeFrame({ kind: FRAME_MESSAGE, payload: bytes('{"t":"next"}') }));
    assert.deepEqual(await channel.next(), { kind: 'broken' });
    assert.deepEqual(await channel.next(), { kind: 'broken' });
  }
});

test('closing the channel ends the window once, wipes a password still waiting, and sends nothing more', async () => {
  const process = new FakeProcess();
  const channel = channelOver(process);
  process.emit(encodeFrame({ kind: FRAME_PASSWORD, payload: bytes('Password1!') }));
  const event = await channel.next();
  process.emit(encodeFrame({ kind: FRAME_PASSWORD, payload: bytes('Password2!') }));
  const written = process.written.length;
  channel.close();
  channel.close();
  channel.send({ t: 'end' });
  assert.equal(process.killed, 1);
  assert.equal(process.written.length, written);
  // The one the session took is the session's to wipe; the one still waiting is gone.
  assert.equal(event.kind, 'password');
  const after = await channel.next();
  assert.notEqual(after.kind, 'password');
});
