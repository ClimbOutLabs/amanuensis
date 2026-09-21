// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  composerDraftKey,
  conversationTransition,
  moveComposerDraft,
  writeComposerDraft,
} from '@/hooks/useComposerDraft.js';

describe('writeComposerDraft', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it('reports whether the draft actually reached storage', () => {
    const key = { scope: 'a', thread: 't' };
    expect(writeComposerDraft({ ...key, text: 'kept' })).toBe(true);
    expect(window.sessionStorage.getItem(composerDraftKey(key))).toBe('kept');

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(writeComposerDraft({ ...key, text: 'dropped' })).toBe(false);
  });
});

describe('moveComposerDraft', () => {
  const from = { scope: 'a', thread: 'local-1' };
  const to = { scope: 'a', thread: 'remote-1' };
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it('moves the draft when the new key is empty', () => {
    writeComposerDraft({ ...from, text: 'old' });
    moveComposerDraft({ from, to });
    expect(window.sessionStorage.getItem(composerDraftKey(to))).toBe('old');
    expect(window.sessionStorage.getItem(composerDraftKey(from))).toBeNull();
  });

  it('keeps newer text already under the new key', () => {
    writeComposerDraft({ ...from, text: 'old' });
    writeComposerDraft({ ...to, text: 'newer' });
    moveComposerDraft({ from, to });
    expect(window.sessionStorage.getItem(composerDraftKey(to))).toBe('newer');
    expect(window.sessionStorage.getItem(composerDraftKey(from))).toBeNull();
  });

  it('keeps the old copy when the new key cannot be written', () => {
    writeComposerDraft({ ...from, text: 'old' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    moveComposerDraft({ from, to });
    expect(window.sessionStorage.getItem(composerDraftKey(from))).toBe('old');
    expect(window.sessionStorage.getItem(composerDraftKey(to))).toBeNull();
  });
});

describe('conversationTransition', () => {
  const local = { scope: 'a', localId: 'local-1', thread: 'local-1' };

  it('treats the first render as a switch', () => {
    expect(conversationTransition({ current: null, next: local })).toBe('switched');
  });

  it('keeps the same conversation when nothing moved', () => {
    expect(conversationTransition({ current: local, next: { ...local } })).toBe('same');
  });

  it('recognizes a new chat receiving its server id as the same conversation', () => {
    expect(conversationTransition({ current: local, next: { ...local, thread: 'remote-9' } })).toBe('renamed');
  });

  it('treats another thread or another account as a switch', () => {
    expect(
      conversationTransition({ current: local, next: { scope: 'a', localId: 'local-2', thread: 'remote-2' } }),
    ).toBe('switched');
    expect(conversationTransition({ current: local, next: { ...local, scope: 'b' } })).toBe('switched');
  });
});
