/**
 * What the voice engine needs from a line to a person. A browser WebSocket and a phone call are two
 * implementations; the engine does not know which one it has. The engine owns everything between:
 * listening, turns, speaking, interrupting and approvals.
 */
import type { Tier3Card } from '@truefoundry/trueforge-core/core';
import type { VoiceServerEvent } from '@truefoundry/trueforge-core/schemas/voiceLine';
import type { RawData } from 'ws';

import type { InputFormat, OutputFormat } from './audio';

/** An answer waiting on the person: the same card the chat shows, found on the finished turn. */
export interface PendingApproval {
  threadId: string;
  toolCallId: string;
  card: Tier3Card | null | undefined;
  tier: 1 | 2 | 3 | undefined;
}

/** What the engine tells the person's screen while it works; the wire shape is the shared schema. */
export type VoiceEvent = Exclude<VoiceServerEvent, { type: 'ready' | 'clear' }>;
export type VoiceState = Extract<VoiceEvent, { type: 'state' }>['state'];

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
  /**
   * With `exact`, the whole text is first checked and spoken only if the voice would say exactly what is
   * written; otherwise this throws `WouldChangeTextError` before any sound. A caller that needs a text heard
   * as written sends it whole, never in pieces, because the check judges the text it is given.
   */
  stream({
    text,
    format,
    signal,
    exact,
  }: {
    text: string;
    format: OutputFormat;
    signal: AbortSignal;
    exact?: boolean;
  }): AsyncIterable<Uint8Array>;
}

/** The voice would say something other than what is written, so the text cannot be checked by ear. */
export class WouldChangeTextError extends Error {
  constructor() {
    super('the voice would not say this text as it is written');
    this.name = 'WouldChangeTextError';
  }
}

/** The voice service answered an exact request without saying it checked the words: it is out of date or not the voice. */
export class UncheckedSpeechError extends Error {
  constructor() {
    super('the voice service did not check the words, so nothing was spoken');
    this.name = 'UncheckedSpeechError';
  }
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
    startedOverHeldLine,
    signal,
    onText,
  }: {
    text: string;
    /** The person began while a line that holds the floor, such as a call's opening, was still playing. */
    startedOverHeldLine?: boolean;
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
  /** False once the card was answered somewhere else, such as on the screen. */
  stillWaiting({ turnId, approval }: { turnId: string; approval: PendingApproval }): Promise<boolean>;
  /** Stops the turn that is running, if any. */
  cancel(): Promise<void>;
}

/** The bytes of one WebSocket message, however `ws` handed them over. */
export function socketBytes(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : data;
}
