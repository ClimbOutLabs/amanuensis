'use client';

import { useCallback, useState } from 'react';

const STORAGE_KEY = 'aui-show-agent-internals';

/** Stored preference; `false` when nothing is stored yet or storage is unavailable. */
function readStoredPreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStoredPreference(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* storage unavailable — the in-memory state still applies for this session */
  }
}

export type AgentInternalsPreference = {
  /** Whether agent-step traces render expanded by default. Off by default. */
  showAgentInternals: boolean;
  setShowAgentInternals: (value: boolean) => void;
};

/**
 * User-level "Show agent internals" setting, persisted to localStorage.
 * Defaults to off: agent step traces collapse to a faint summary line unless
 * the user opts into always seeing the full trace.
 */
export function useAgentInternalsPreference(): AgentInternalsPreference {
  const [showAgentInternals, setShowAgentInternalsState] = useState<boolean>(readStoredPreference);

  const setShowAgentInternals = useCallback((value: boolean) => {
    setShowAgentInternalsState(value);
    writeStoredPreference(value);
  }, []);

  return { showAgentInternals, setShowAgentInternals };
}
