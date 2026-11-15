import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  encodeFrame,
  FRAME_MESSAGE,
  FRAME_PASSWORD,
  FRAME_SHOW_ONCE,
  FrameError,
  FrameReader,
  MESSAGE_FRAME_CAP,
  PASSWORD_FRAME_CAP,
} from '../../src/window/frames.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test('a frame comes back out as it went in, however the bytes are cut', () => {
  const sent = [
    encodeFrame({ kind: FRAME_MESSAGE, payload: bytes('{"t":"next"}') }),
    encodeFrame({ kind: FRAME_PASSWORD, payload: bytes('Password1!') }),
    encodeFrame({ kind: FRAME_MESSAGE, payload: new Uint8Array() }),
  ];
  const all = new Uint8Array(sent.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of sent) {
    all.set(part, at);
    at += part.length;
  }
  for (const size of [1, 2, 3, 7, all.length]) {
    const reader = new FrameReader();
    const frames = [];
    for (let offset = 0; offset < all.length; offset += size) {
      frames.push(...reader.push(all.slice(offset, offset + size)));
    }
    assert.deepEqual(
      frames.map(frame => [frame.kind, new TextDecoder().decode(frame.payload)]),
      [
        [FRAME_MESSAGE, '{"t":"next"}'],
        [FRAME_PASSWORD, 'Password1!'],
        [FRAME_MESSAGE, ''],
      ],
    );
  }
});

test('a password made of line breaks, braces, quotes and empty bytes stays one password frame', () => {
  const nasty = new Uint8Array([0x0a, 0x7b, 0x7d, 0x22, 0x00, 0x0d, 0x0a, 0x01, 0x02, 0x7b, 0x22, 0x74, 0x22, 0x3a]);
  const wire = new Uint8Array([
    ...encodeFrame({ kind: FRAME_PASSWORD, payload: nasty }),
    ...encodeFrame({ kind: FRAME_MESSAGE, payload: bytes('{"t":"about","email":"a@b.c"}') }),
  ]);
  for (const size of [1, 5, wire.length]) {
    const reader = new FrameReader();
    const frames = [];
    for (let offset = 0; offset < wire.length; offset += size) {
      frames.push(...reader.push(wire.slice(offset, offset + size)));
    }
    assert.equal(frames.length, 2);
    assert.equal(frames[0]?.kind, FRAME_PASSWORD);
    assert.deepEqual([...(frames[0]?.payload ?? [])], [...nasty]);
    assert.equal(frames[1]?.kind, FRAME_MESSAGE);
  }
});

test('a frame longer than its kind allows is refused from its header, before its bytes arrive', () => {
  for (const [kind, cap] of [
    [FRAME_MESSAGE, MESSAGE_FRAME_CAP],
    [FRAME_PASSWORD, PASSWORD_FRAME_CAP],
  ] as const) {
    const header = new Uint8Array(5);
    header[0] = kind;
    new DataView(header.buffer).setUint32(1, cap + 1, false);
    assert.throws(() => new FrameReader().push(header), FrameError);
  }
  // The length is read as an unsigned number: the largest one is refused, not read as a small or negative one.
  const huge = new Uint8Array([FRAME_MESSAGE, 0xff, 0xff, 0xff, 0xff]);
  assert.throws(() => new FrameReader().push(huge), FrameError);
});

test('a frame of an unknown kind, or of the kind kept for later, is refused', () => {
  for (const kind of [0x00, FRAME_SHOW_ONCE, 0x04, 0x7b, 0xff]) {
    assert.throws(() => new FrameReader().push(new Uint8Array([kind, 0, 0, 0, 0])), FrameError);
  }
});

test('a reader that refused once refuses everything after it', () => {
  const reader = new FrameReader();
  assert.throws(() => reader.push(new Uint8Array([0x09, 0, 0, 0, 0])), FrameError);
  assert.throws(() => reader.push(encodeFrame({ kind: FRAME_MESSAGE, payload: bytes('{}') })), FrameError);
});

test('a frame too long to send is refused', () => {
  assert.throws(
    () => encodeFrame({ kind: FRAME_PASSWORD, payload: new Uint8Array(PASSWORD_FRAME_CAP + 1) }),
    FrameError,
  );
});
