import { useSyncExternalStore } from 'react';

/**
 * Where the live voice conversation is: off, opening, or one of the three calm states the server
 * reports. Module state, because the mic button and the avatar sit in different subtrees.
 */
export type VoiceModeState = 'off' | 'connecting' | 'listening' | 'thinking' | 'speaking';

let state: VoiceModeState = 'off';
const listeners = new Set<() => void>();

export function getVoiceMode(): VoiceModeState {
  return state;
}

export function setVoiceMode(next: VoiceModeState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useVoiceMode(): VoiceModeState {
  return useSyncExternalStore(subscribe, getVoiceMode, () => 'off');
}
