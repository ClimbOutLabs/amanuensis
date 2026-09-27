// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSpeechRecognition } from '@/voice/useSpeechRecognition.js';

/** Minimal fake for the browser SpeechRecognition constructor. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  interimResults = false;
  continuous = false;
  abort = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor() {
    FakeRecognition.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  fire(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function installFakeRecognition() {
  FakeRecognition.instances = [];
  (window as unknown as Record<string, unknown>)['SpeechRecognition'] = FakeRecognition;
}

function lastInstance(): FakeRecognition {
  const instance = FakeRecognition.instances[FakeRecognition.instances.length - 1];
  if (instance === undefined) throw new Error('expected a recognition instance');
  return instance;
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)['SpeechRecognition'];
});

describe('useSpeechRecognition', () => {
  it('reports unsupported when the browser has no SpeechRecognition', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    expect(result.current.supported).toBe(false);
  });

  it('forwards engine errors (e.g. mic denied) to onError', () => {
    installFakeRecognition();
    const onError = vi.fn();
    const { result } = renderHook(() => useSpeechRecognition({ onError }));

    expect(result.current.supported).toBe(true);
    act(() => {
      result.current.start();
    });

    act(() => {
      lastInstance().fire('error', { error: 'not-allowed' });
    });
    expect(onError).toHaveBeenCalledWith('not-allowed');
  });

  it('ignores the aborted pseudo-error', () => {
    installFakeRecognition();
    const onError = vi.fn();
    const { result } = renderHook(() => useSpeechRecognition({ onError }));

    act(() => {
      result.current.start();
    });
    act(() => {
      lastInstance().fire('error', { error: 'aborted' });
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('aborts the live instance on unmount', () => {
    installFakeRecognition();
    const { result, unmount } = renderHook(() => useSpeechRecognition());

    act(() => {
      result.current.start();
    });
    const instance = lastInstance();
    unmount();
    expect(instance.abort).toHaveBeenCalled();
  });
});
