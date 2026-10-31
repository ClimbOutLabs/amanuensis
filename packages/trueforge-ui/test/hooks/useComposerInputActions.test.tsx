import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { composerState, mockSetText, mockShowError } = vi.hoisted(() => ({
  composerState: { text: '' },
  mockSetText: vi.fn(),
  mockShowError: vi.fn(),
}));

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ composer: () => ({ setText: mockSetText, getState: () => composerState }) }),
}));

vi.mock('@/containers/ToasterContainer.js', () => ({
  useToasterOptional: () => ({ showError: mockShowError }),
}));

import { appendPasted, useComposerInputActions } from '@/hooks/useComposerInputActions.js';

function installClipboard(readText: () => Promise<string>) {
  Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true });
}

describe('useComposerInputActions', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
    composerState.text = '';
    mockSetText.mockClear();
    mockShowError.mockClear();
  });

  it('offers nothing to a person who cannot add to the chat', () => {
    installClipboard(async () => 'x');
    const { result } = renderHook(() => useComposerInputActions(undefined));
    expect(result.current).toEqual([]);
  });

  it('leaves paste out when the browser cannot read the clipboard', () => {
    const { result } = renderHook(() => useComposerInputActions(vi.fn()));
    expect(result.current.map(action => action.id)).toEqual(['attach']);
  });

  it('pastes clipboard text after the draft', async () => {
    installClipboard(async () => 'from the clipboard');
    composerState.text = 'my draft';
    const { result } = renderHook(() => useComposerInputActions(vi.fn()));
    const paste = result.current.find(action => action.id === 'paste');

    await act(async () => {
      paste?.onSelect();
      await Promise.resolve();
    });

    expect(mockSetText).toHaveBeenCalledWith('my draft\nfrom the clipboard');
  });

  it('says what to do when the clipboard cannot be read', async () => {
    installClipboard(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const { result } = renderHook(() => useComposerInputActions(vi.fn()));

    await act(async () => {
      result.current.find(action => action.id === 'paste')?.onSelect();
      await Promise.resolve();
    });

    expect(mockSetText).not.toHaveBeenCalled();
    expect(mockShowError).toHaveBeenCalledWith(expect.any(Error), { title: 'Could not paste' });
  });

  it('appendPasted keeps an empty draft clean and adds a new line otherwise', () => {
    expect(appendPasted('', 'hi')).toBe('hi');
    expect(appendPasted('a', '')).toBe('a');
    expect(appendPasted('a\n', 'b')).toBe('a\nb');
  });
});
