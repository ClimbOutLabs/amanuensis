// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import {
  applyHeldPersona,
  awaitPendingPersonaMutation,
  dropHeldPersonaUnlessFor,
  heldPersonaFor,
  holdPersonaForNewChat,
  registerPersonaMutation,
} from '@/personaMutationGate.js';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  // The executor runs synchronously, so both are set; guard anyway.
  if (resolveFn === undefined || rejectFn === undefined) {
    throw new Error('Promise executor did not run');
  }
  return { promise, resolve: resolveFn, reject: rejectFn };
}

describe('personaMutationGate', () => {
  it('resolves immediately when no mutation is pending', async () => {
    await expect(awaitPendingPersonaMutation()).resolves.toBeUndefined();
  });

  it('waits for a pending mutation before resolving', async () => {
    const gate = deferred();
    registerPersonaMutation(gate.promise);
    let settled = false;
    const waiter = awaitPendingPersonaMutation().then(() => {
      settled = true;
    });
    // Let the microtask queue run; the waiter must still be pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await waiter;
    expect(settled).toBe(true);
  });

  it('does not reject when the mutation fails', async () => {
    const gate = deferred();
    registerPersonaMutation(gate.promise);
    const waiter = awaitPendingPersonaMutation();
    gate.reject(new Error('PUT failed'));
    await expect(waiter).resolves.toBeUndefined();
    // The failed mutation clears itself; a later wait resolves immediately.
    await expect(awaitPendingPersonaMutation()).resolves.toBeUndefined();
  });

  it('a newer registration supersedes an older one', async () => {
    const first = deferred();
    const second = deferred();
    registerPersonaMutation(first.promise);
    registerPersonaMutation(second.promise);
    // Resolving the first must not release the gate while the second is pending.
    let settled = false;
    const waiter = awaitPendingPersonaMutation().then(() => {
      settled = true;
    });
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    second.resolve();
    await waiter;
    expect(settled).toBe(true);
  });

  it('drops a pick held for another chat, so it never applies to the wrong one', async () => {
    const apply = vi.fn(async () => undefined);
    holdPersonaForNewChat({ threadId: 'chat-a', personaId: 'p-1', apply });
    expect(heldPersonaFor('chat-a')).toBe('p-1');
    dropHeldPersonaUnlessFor('chat-a');
    expect(heldPersonaFor('chat-a')).toBe('p-1');
    dropHeldPersonaUnlessFor('chat-b');
    expect(heldPersonaFor('chat-a')).toBeUndefined();
    await applyHeldPersona('sess-b');
    expect(apply).not.toHaveBeenCalled();
  });

  it('lets the first turn run when applying the held pick fails', async () => {
    holdPersonaForNewChat({
      threadId: 'chat-a',
      personaId: 'p-1',
      apply: () => Promise.reject(new Error('PUT failed')),
    });
    await expect(applyHeldPersona('sess-a')).resolves.toBeUndefined();
  });
});
