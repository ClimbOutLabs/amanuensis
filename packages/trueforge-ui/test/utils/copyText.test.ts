// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyText } from '@/utils/copyText.js';

function setSecureContext(secure: boolean) {
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
}

function setClipboard(value: { writeText: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

describe('copyText', () => {
  afterEach(() => {
    setSecureContext(true);
    setClipboard(undefined);
    vi.restoreAllMocks();
  });

  it('uses the clipboard API where the page is secure', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setSecureContext(true);
    setClipboard({ writeText });
    await copyText('hello');
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to selecting a hidden field on a plain http address, where navigator.clipboard is missing', async () => {
    setSecureContext(false);
    setClipboard(undefined);
    let copied = '';
    const exec = vi.fn((command: string) => {
      copied = document.querySelector('textarea')?.value ?? '';
      return command === 'copy';
    });
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    await expect(copyText('über text')).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledWith('copy');
    expect(copied).toBe('über text');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('says so when the browser refuses to copy, and still removes the hidden field', async () => {
    setSecureContext(false);
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });
    await expect(copyText('x')).rejects.toThrow('Copying is not available in this browser');
    expect(document.querySelector('textarea')).toBeNull();
  });
});
