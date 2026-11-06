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

/** What the page does with what the live line reports. Set by whichever voice button is on screen now. */
export type LiveLineHandlers = {
  onTurnSaved: () => void;
  onNotice: (text: string) => void;
  /** The line closed or the mic was lost, after the line was already cleaned up. */
  onEnded: (reason: 'closed' | 'mic_lost') => void;
};

type LiveLine = { stop: () => void; sessionId: string };

let line: LiveLine | null = null;
let handlers: LiveLineHandlers | null = null;
let buttonsOnScreen = 0;
let starting: AbortController | null = null;

/**
 * The open voice line lives here, not in the button, because the composer is rebuilt in another
 * place when an approval card appears and the conversation has to carry on through it.
 */
export function getLiveLineSession(): string | null {
  return line?.sessionId ?? null;
}

export function hasLiveLine(): boolean {
  return line !== null;
}

export function setLiveLine(next: LiveLine): void {
  line = next;
}

/** A new start replaces one still opening; the replaced one sees its signal aborted and lets go of what it opened. */
export function beginLiveStart(): AbortController {
  starting?.abort();
  starting = new AbortController();
  return starting;
}

export function finishLiveStart(controller: AbortController): void {
  if (starting === controller) starting = null;
}

/** Ends the line if there is one, or a start still opening, and returns voice mode to off. */
export function endLiveLine(): void {
  starting?.abort();
  starting = null;
  const ending = line;
  line = null;
  ending?.stop();
  setVoiceMode('off');
}

/** The line closed by itself: forget it and tell the page why. */
export function liveLineEnded(reason: 'closed' | 'mic_lost'): void {
  line = null;
  setVoiceMode('off');
  handlers?.onEnded(reason);
}

export const liveLineEvents = {
  onTurnSaved: () => handlers?.onTurnSaved(),
  onNotice: (text: string) => handlers?.onNotice(text),
};

/**
 * A voice button is on screen and takes the line's reports. When the last one goes and none comes
 * back in the same moment (a rebuild), the line ends: nobody is left to show or stop it.
 */
export function mountVoiceButton(next: LiveLineHandlers): () => void {
  buttonsOnScreen += 1;
  handlers = next;
  return () => {
    buttonsOnScreen -= 1;
    if (handlers === next) handlers = null;
    setTimeout(() => {
      if (buttonsOnScreen === 0) endLiveLine();
    }, 0);
  };
}
