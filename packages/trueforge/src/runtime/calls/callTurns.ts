import { wordsOf } from '../../voice/echoGuard';
import type { TurnOutcome, VoiceTurnRunner } from '../../voice/transport';

/** What the person answered to "Is this a good time?". */
type GoodTimeAnswer = 'yes' | 'no' | 'unclear';

const NO_WORDS = new Set(['no', 'nope', 'not', 'busy', 'later', 'bad', 'cant', 'cannot', 'driving', 'stop']);
/** Words that are only ever a yes. "Go", "fine", "ok" and "alright" are left out: each also starts other replies. */
const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'okay']);
/** Every question mark in use: Latin, Arabic, interrobang, reversed, and the emoji; NFKC folds the full-width ones. */
const QUESTION_MARKS = /[?¿؟‽⸮❓❔]/;
/** A yes is short: anything longer is a person saying something else, or not the person at all. */
const MOST_YES_WORDS = 3;
/** A "no" word that means yes or nothing at all, so the question is asked again. */
const NO_THAT_IS_NOT_NO = ['no problem', 'no worries', 'not busy', 'not bad', 'why not'];

/**
 * A plain yes or no. Only a reply of one to three words that are all yes words, with no question mark, is a yes, so a
 * greeting, a question or someone handing over the phone is never taken for one. A "no" word is a no, unless it is part
 * of a phrase like "no problem", which is asked again. This only decides whether the assistant may say more on the
 * call; it never approves anything.
 */
export function goodTimeAnswer(heard: string): GoodTimeAnswer {
  const words = wordsOf(heard).map(word => word.replace(/'/g, ''));
  const phrase = ` ${words.join(' ')} `;
  if (NO_THAT_IS_NOT_NO.some(words => phrase.includes(` ${words} `))) {
    return 'unclear';
  }
  if (words.some(word => NO_WORDS.has(word))) {
    return 'no';
  }
  // A puzzled "Yeah?" is someone asking who is there, not saying yes, wherever the question mark falls.
  const asked = QUESTION_MARKS.test(heard.normalize('NFKC'));
  const yes = !asked && words.length > 0 && words.length <= MOST_YES_WORDS && words.every(word => YES_WORDS.has(word));
  return yes ? 'yes' : 'unclear';
}

/** The lines a call speaks before and around the conversation. Every name in them comes from the person's settings. */
export const CALL_LINES = {
  /** Private mode: who is calling, who for, and only the kind of thing until the person says it is a good time. */
  opening: ({ name, person, kind }: { name: string; person: string | undefined; kind: string }): string =>
    `Hi, this is ${name}, calling for ${person ?? 'the person who set me up'}. ${capitalized(kind)}. Is this a good time?`,
  /** Once the person said yes. The chat holds this line, with the greeting, as the start of the conversation. */
  message: (message: string): string =>
    `${withStop(message)} You can ask me about it. To do something about it, open the app.`,
  notNow: 'Okay. It is waiting in the app for you. Goodbye.',
  /** Holds no yes or no word, so an answer said right after it is never taken for its echo. */
  askAgain: 'Sorry, I did not catch that. Is this a good time? A one-word answer is best.',
  giveUp: 'I will leave it in the app for you. Goodbye.',
  noChat: 'I cannot talk it through on the phone right now. Please open the app to see it. Goodbye.',
  timeUp: 'I need to go now. Please open the app. Goodbye.',
  voicemail: (name: string): string => `This is ${name}. Something needs you. Please open the app.`,
} as const;

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function withStop(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Why a call ended before a conversation: the person said no, no yes was heard, or no chat could open. */
type CallEnding = 'said_no' | 'unclear' | 'no_chat';

/** The conversation a call has once the person said yes, and the chat it is written into when there is one. */
export interface CallChat {
  turns: VoiceTurnRunner;
  /**
   * Writes the chat, once the person heard what the call is about. Resolves to its id, or undefined when no chat is
   * written. Called again, it resolves to the same chat.
   */
  begin: () => Promise<string | undefined>;
}

/**
 * The turns of a phone call. Until the person says it is a good time, nothing they say reaches the model and the
 * assistant says only who it is calling for and the kind of thing. After that, each utterance goes to the call's
 * chat. An approval is never answered by voice on a call: the line says false, and this runner refuses one even if
 * asked.
 */
export class CallTurns implements VoiceTurnRunner {
  readonly #message: string;
  readonly #openChat: () => Promise<CallChat | undefined>;
  readonly #hangUp: () => void;
  readonly #askedAgain: () => void;
  readonly #sayMessage: (line: string) => void;
  readonly #failed: (error: unknown) => void;
  #phase: 'asking' | 'open' | 'closing' = 'asking';
  #unclear = 0;
  #replies = 0;
  #chat: CallChat | undefined;
  #ending: CallEnding | undefined;

  constructor({
    message,
    openChat,
    hangUp,
    askedAgain = () => undefined,
    sayMessage,
    failed = () => undefined,
  }: {
    /** The line that says what the call is about, said only after a yes. */
    message: string;
    openChat: () => Promise<CallChat | undefined>;
    /** Ends the call once what is being said has played. */
    hangUp: () => void;
    /** The question was asked again, so a wait for its answer can start again. */
    askedAgain?: () => void;
    /** Says what the call is about. */
    sayMessage: (line: string) => void;
    /** A turn ended as failed; told why so it can be logged without anything that was said. */
    failed?: (error: unknown) => void;
  }) {
    this.#message = message;
    this.#openChat = openChat;
    this.#hangUp = hangUp;
    this.#askedAgain = askedAgain;
    this.#sayMessage = sayMessage;
    this.#failed = failed;
  }

  /** Whether the person said it was a good time. */
  get answered(): boolean {
    return this.#phase === 'open' || this.#chat !== undefined;
  }

  get chat(): CallChat | undefined {
    return this.#chat;
  }

  /** Why the call ended before a conversation, once it has. */
  get ending(): CallEnding | undefined {
    return this.#ending;
  }

  /** Replies heard to the question so far, so a silence timer can tell whether one came. */
  get replies(): number {
    return this.#replies;
  }

  /**
   * The person said nothing after the question: counted like a reply that was not caught. Resolves to the line to say,
   * and whether the call ends after it; undefined once the question is answered.
   */
  heardNothing(): { line: string; end: boolean } | undefined {
    if (this.#phase !== 'asking') {
      return undefined;
    }
    this.#unclear += 1;
    if (this.#unclear >= 2) {
      this.#phase = 'closing';
      this.#ending = 'unclear';
      return { line: CALL_LINES.giveUp, end: true };
    }
    return { line: CALL_LINES.askAgain, end: false };
  }

  /** A turn that cannot be run ends as a failed turn, never as an error the call does not expect. */
  async sendMessage(input: {
    text: string;
    startedOverHeldLine?: boolean;
    signal: AbortSignal;
    onText: (delta: string) => void;
  }): Promise<TurnOutcome> {
    try {
      return await this.#answer(input);
    } catch (error) {
      this.#failed(error);
      return { kind: 'failed' };
    }
  }

  async #answer({
    text,
    startedOverHeldLine = false,
    signal,
    onText,
  }: {
    text: string;
    startedOverHeldLine?: boolean;
    signal: AbortSignal;
    onText: (delta: string) => void;
  }): Promise<TurnOutcome> {
    if (this.#phase === 'open' && this.#chat !== undefined) {
      return this.#chat.turns.sendMessage({ text, signal, onText });
    }
    if (this.#phase === 'closing' || startedOverHeldLine) {
      // A reply that began over the opening was not an answer to a question the person had heard.
      return { kind: 'done', turnId: '', approvals: [] };
    }
    this.#replies += 1;
    const answer = goodTimeAnswer(text);
    if (answer === 'yes') {
      const chat = await this.#openChat();
      if (chat === undefined) {
        return this.#close({ line: CALL_LINES.noChat, ending: 'no_chat', onText });
      }
      this.#chat = chat;
      this.#phase = 'open';
      this.#sayMessage(this.#message);
      return { kind: 'done', turnId: '', approvals: [] };
    }
    if (answer === 'no') {
      return this.#close({ line: CALL_LINES.notNow, ending: 'said_no', onText });
    }
    this.#unclear += 1;
    if (this.#unclear >= 2) {
      return this.#close({ line: CALL_LINES.giveUp, ending: 'unclear', onText });
    }
    onText(CALL_LINES.askAgain);
    this.#askedAgain();
    return { kind: 'done', turnId: '', approvals: [] };
  }

  /** Never answered on a call: the card stays waiting in the app, whatever was heard. */
  answerApproval(): Promise<TurnOutcome> {
    return Promise.resolve({ kind: 'refused', reason: 'not_allowed' });
  }

  /** No card is ever waited on during a call, since none can be answered on one. */
  stillWaiting(): Promise<boolean> {
    return Promise.resolve(false);
  }

  async cancel(): Promise<void> {
    await this.#chat?.turns.cancel();
  }

  #close({ line, ending, onText }: { line: string; ending: CallEnding; onText: (delta: string) => void }): TurnOutcome {
    this.#phase = 'closing';
    this.#ending = ending;
    onText(line);
    this.#hangUp();
    return { kind: 'done', turnId: '', approvals: [] };
  }
}
