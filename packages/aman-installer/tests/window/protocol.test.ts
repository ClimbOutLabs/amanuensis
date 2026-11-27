import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseFromWindow, ProtocolError } from '../../src/window/protocol.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test('each message the window may send is read', () => {
  assert.deepEqual(parseFromWindow(bytes('{"t":"next"}')), { t: 'next' });
  assert.deepEqual(parseFromWindow(bytes('{"t":"back"}')), { t: 'back' });
  assert.deepEqual(parseFromWindow(bytes('{"t":"closing"}')), { t: 'closing' });
  assert.deepEqual(parseFromWindow(bytes('{"t":"about","email":"friend@example.com"}')), {
    t: 'about',
    email: 'friend@example.com',
  });
  assert.deepEqual(parseFromWindow(bytes('{"t":"options","phone":true}')), { t: 'options', phone: true });
  assert.deepEqual(
    parseFromWindow(
      bytes(
        '{"t":"hello","windowsDir":"C:\\\\Windows","systemDir":"C:\\\\Windows\\\\System32","modulePath":"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe","languageMode":"FullLanguage"}',
      ),
    ),
    {
      t: 'hello',
      windowsDir: 'C:\\Windows',
      systemDir: 'C:\\Windows\\System32',
      modulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      languageMode: 'FullLanguage',
    },
  );
});

test('anything that is not exactly one of those messages is refused', () => {
  const refused = [
    '',
    'next',
    '[]',
    'null',
    '"next"',
    '{}',
    '{"t":"start"}',
    '{"t":"run","command":"calc.exe"}',
    '{"t":"next","extra":1}',
    '{"t":"about"}',
    '{"t":"about","email":5}',
    '{"t":"about","email":"a@b.c","password":"Password1!"}',
    `{"t":"about","email":"${'a'.repeat(255)}"}`,
    '{"t":"options","phone":"yes"}',
    '{"t":"options","phone":true,"port":8791}',
    '{"t":"hello","windowsDir":"C:\\\\Windows"}',
    '{"t":"next"}{"t":"next"}',
  ];
  for (const text of refused) {
    assert.throws(() => parseFromWindow(bytes(text)), ProtocolError, text);
  }
  assert.throws(() => parseFromWindow(new Uint8Array([0x7b, 0xff, 0x7d])), ProtocolError);
});
