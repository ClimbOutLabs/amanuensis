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

/** What the page does with what the live line reports. Set once by the chat's bridge, which outlives the composer. */
export type LiveLineHandlers = {
  onTurnSaved: () => void;
  /** The line closed or the mic was lost, after the line was already cleaned up. */
  onEnded: (reason: 'closed' | 'mic_lost') => void;
};

type LiveLine = { stop: () => void; sessionId: string };
type LiveStart = { controller: AbortController; sessionId: string | null };

let line: LiveLine | null = null;
let handlers: LiveLineHandlers | null = null;
let starting: LiveStart | null = null;
/** The chat on screen, as the bridge last reported it; null for a new chat that has no id yet. */
let displayedChat: string | null = null;

/**
 * The open voice line lives here, not in the button, because the composer is rebuilt in another place
 * (an approval card) or goes away for a moment (the chat reloads after a spoken turn) and the
 * conversation has to carry on through it. The chat's bridge ends it when the chat does.
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
export function beginLiveStart(sessionId: string | null): AbortController {
  starting?.controller.abort();
  const controller = new AbortController();
  starting = { controller, sessionId };
  return controller;
}

/**
 * A new chat gets its id while its line is opening; the start now belongs to that chat. If the person moved to
 * another chat meanwhile, the start ends instead of opening a line on a chat that is no longer shown.
 */
export function nameLiveStartSession({
  controller,
  sessionId,
}: {
  controller: AbortController;
  sessionId: string;
}): void {
  if (starting?.controller !== controller) return;
  if (displayedChat !== null && displayedChat !== sessionId) {
    endLiveLine();
    return;
  }
  starting.sessionId = sessionId;
}

export function finishLiveStart(controller: AbortController): void {
  if (starting?.controller === controller) starting = null;
}

/** Ends the line if there is one, or a start still opening, and returns voice mode to off. */
export function endLiveLine(): void {
  starting?.controller.abort();
  starting = null;
  const ending = line;
  line = null;
  ending?.stop();
  setVoiceMode('off');
}

/**
 * The chat shows another chat: a line or a start for the old one ends. A start that has no chat yet
 * (a new chat getting its id) stays.
 */
export function chatChanged(sessionId: string | null): void {
  displayedChat = sessionId;
  if (line !== null && line.sessionId !== sessionId) endLiveLine();
  if (starting !== null && starting.sessionId !== null && starting.sessionId !== sessionId) endLiveLine();
}

/** The line closed by itself: forget it and tell the page why. */
export function liveLineEnded(reason: 'closed' | 'mic_lost'): void {
  line = null;
  setVoiceMode('off');
  handlers?.onEnded(reason);
}

/** A plain-words message from the voice line or the voice buttons, shown by the button when it is on screen. */
let notice: string | null = null;
const noticeListeners = new Set<() => void>();

export function setLiveNotice(next: string | null): void {
  if (notice === next) return;
  notice = next;
  for (const listener of noticeListeners) listener();
}

export function useLiveNotice(): string | null {
  return useSyncExternalStore(
    listener => {
      noticeListeners.add(listener);
      return () => {
        noticeListeners.delete(listener);
      };
    },
    () => notice,
    () => null,
  );
}

export const liveLineEvents = {
  onTurnSaved: () => handlers?.onTurnSaved(),
  onNotice: setLiveNotice,
};

/**
 * The chat's bridge takes the line's reports for as long as the chat is on screen, and ends the line
 * when the chat goes. It does not depend on any button being on screen.
 */
export function mountLiveLineBridge(next: LiveLineHandlers): () => void {
  handlers = next;
  return () => {
    if (handlers === next) handlers = null;
    displayedChat = null;
    endLiveLine();
    setLiveNotice(null);
  };
}
