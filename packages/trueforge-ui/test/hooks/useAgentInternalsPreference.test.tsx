// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useAgentInternalsPreference } from '@/hooks/useAgentInternalsPreference.js';

const STORAGE_KEY = 'aui-show-agent-internals';

describe('useAgentInternalsPreference', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to off', () => {
    const { result } = renderHook(() => useAgentInternalsPreference());
    expect(result.current.showAgentInternals).toBe(false);
  });

  it('persists the choice to localStorage', () => {
    const { result } = renderHook(() => useAgentInternalsPreference());

    act(() => {
      result.current.setShowAgentInternals(true);
    });

    expect(result.current.showAgentInternals).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1');
  });

  it('reads back a persisted opt-in', () => {
    window.localStorage.setItem(STORAGE_KEY, '1');
    const { result } = renderHook(() => useAgentInternalsPreference());
    expect(result.current.showAgentInternals).toBe(true);
  });

  it('treats unparseable stored values as off', () => {
    window.localStorage.setItem(STORAGE_KEY, 'yes');
    const { result } = renderHook(() => useAgentInternalsPreference());
    expect(result.current.showAgentInternals).toBe(false);
  });
});
