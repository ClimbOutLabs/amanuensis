/**
 * What the voice engine needs from a line to a person. A browser WebSocket and a phone call are two
 * implementations; the engine does not know which one it has. The engine owns everything between:
 * listening, turns, speaking, interrupting and approvals.
 */
import type { Tier3Card } from '@truefoundry/trueforge-core/core';
import type { InputFormat, OutputFormat } from './audio';

export type VoiceState = 'listening' | 'thinking' | 'speaking';

/** An answer waiting on the person: the same card the chat shows, found on the finished turn. */
export interface PendingApproval {
  threadId: string;
  toolCallId: string;
  card: Tier3Card | null | undefined;
  tier: 1 | 2 | 3 | undefined;
}

export type VoiceEvent =
  | { type: 'state'; state: VoiceState }
  /** What the engine heard the person say; the chat itself holds the saved turn. */
  | { type: 'heard'; text: string }
  /** A turn was saved in the chat, so the screen can refresh it. */
  | { type: 'turn_saved'; turn_id: string }
  /** A plain-words message for the person that is not part of the conversation. */
  | { type: 'notice'; text: string };

export interface VoiceTransport {
  /** What `sendAudio` receives and what the line plays; the engine asks the voice for exactly this. */
  readonly outputFormat: OutputFormat;
  /** What the line sends in: the engine turns it into 16 kHz samples. */
  readonly inputFormat: InputFormat;
  /**
   * Whether the person on this line may answer approval cards by voice. A phone line cannot tell
   * who answered, so it says false and every card is left waiting in the app.
   */
  readonly voiceApprovals: boolean;
  /** Queues audio for playback, in order. */
  sendAudio(chunk: Uint8Array): void;
  /** Drops everything queued and stops what is playing, at once. */
  clearAudio(): void;
  sendEvent(event: VoiceEvent): void;
  close(): void;
}

/** What the engine reads for a finished spoken sentence (speech to text). */
export interface SpeechToText {
  transcribe({ samples, signal }: { samples: Int16Array; signal: AbortSignal }): Promise<string>;
}

/** What the engine reads to speak (text to speech): audio in the transport's own format, as it is made. */
export interface SpeechSynthesizer {
  stream({
    text,
    format,
    signal,
  }: {
    text: string;
    format: OutputFormat;
    signal: AbortSignal;
  }): AsyncIterable<Uint8Array>;
}

export type TurnRefusal = 'expired' | 'changed' | 'not_allowed' | 'tool_gone' | 'sign_in';

export type TurnOutcome =
  | { kind: 'done'; turnId: string; approvals: PendingApproval[] }
  | { kind: 'refused'; reason: TurnRefusal }
  | { kind: 'failed' };

/** Runs turns in one chat, exactly as the chat's own send would, and streams the reply text. */
export interface VoiceTurnRunner {
  sendMessage({
    text,
    signal,
    onText,
  }: {
    text: string;
    signal: AbortSignal;
    onText: (delta: string) => void;
  }): Promise<TurnOutcome>;
  answerApproval({
    approval,
    decision,
    signal,
    onText,
  }: {
    approval: PendingApproval;
    decision: 'allow' | 'deny';
    signal: AbortSignal;
    onText: (delta: string) => void;
  }): Promise<TurnOutcome>;
  /** Stops the turn that is running, if any. */
  cancel(): Promise<void>;
}
