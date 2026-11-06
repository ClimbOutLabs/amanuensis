import { wordsOf } from '../../voice/echoGuard';
import type { TurnOutcome, VoiceTurnRunner } from '../../voice/transport';

/** What the person answered to "Is this a good time?". */
export type GoodTimeAnswer = 'yes' | 'no' | 'unclear';

const NO_WORDS = new Set(['no', 'nope', 'not', 'busy', 'later', 'bad', 'cant', 'cannot', 'driving', 'stop']);
const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'fine', 'alright', 'go']);

/**
 * A plain yes or no. A "no" word wins over a "yes" word, so "not a good time" is a no. This only decides whether the
 * assistant may say more on the call; it never approves anything.
 */
export function goodTimeAnswer(heard: string): GoodTimeAnswer {
  const words = wordsOf(heard).map(word => word.replace(/'/g, ''));
  if (words.some(word => NO_WORDS.has(word))) {
    return 'no';
  }
  return words.some(word => YES_WORDS.has(word)) ? 'yes' : 'unclear';
}

/** The lines a call speaks before and around the conversation. Every name in them comes from the person's settings. */
export const CALL_LINES = {
  /** Private mode: only the kind of thing until the person says it is a good time. */
  opening: ({ name, kind }: { name: string; kind: string }): string =>
    `Hi, it's ${name}. ${capitalized(kind)}. Is this a good time?`,
  /** Once the person said yes. The chat holds this line, with the greeting, as the start of the conversation. */
  message: (message: string): string => `${withStop(message)} Want me to do something about it?`,
  notNow: 'Okay. It is waiting in the app for you. Goodbye.',
  askAgain: 'Sorry, I did not catch that. Is this a good time? Please say yes or no.',
  giveUp: 'I will leave it in the app for you. Goodbye.',
  noChat: 'I cannot talk it through on the phone right now. Please open the app to see it. Goodbye.',
  timeUp: 'I need to go now. Everything we said is in the chat in the app. Goodbye.',
  voicemail: (name: string): string => `${name} here, something needs you, please open the app.`,
} as const;

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function withStop(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The chat a call talks in, once the person said yes: its turns run exactly as a typed message's would. */
export interface CallChat {
  session_id: string;
  turns: VoiceTurnRunner;
  /** Called once the call is over, so nothing can act as the person any more. */
  close: () => void;
}

/**
 * The turns of a phone call. Until the person says it is a good time, nothing they say reaches the model and the
 * assistant says only the kind of thing. After that, each utterance is a normal turn in the call's chat. An approval
 * is never answered by voice on a call: the line says false, and this runner refuses one even if asked.
 */
export class CallTurns implements VoiceTurnRunner {
  readonly #message: string;
  readonly #openChat: () => Promise<CallChat | undefined>;
  readonly #hangUp: () => void;
  #phase: 'asking' | 'open' | 'closing' = 'asking';
  #unclear = 0;
  #chat: CallChat | undefined;
  #followUps = 0;

  constructor({
    message,
    openChat,
    hangUp,
  }: {
    /** What the call is about, said only after a yes. */
    message: string;
    openChat: () => Promise<CallChat | undefined>;
    /** Ends the call once what is being said has played. */
    hangUp: () => void;
  }) {
    this.#message = message;
    this.#openChat = openChat;
    this.#hangUp = hangUp;
  }

  /** Whether the person said it was a good time. */
  get answered(): boolean {
    return this.#phase === 'open' || this.#chat !== undefined;
  }

  get chat(): CallChat | undefined {
    return this.#chat;
  }

  /** Approval cards the call left waiting in the app. */
  get followUps(): number {
    return this.#followUps;
  }

  async sendMessage({
    text,
    signal,
    onText,
  }: {
    text: string;
    signal: AbortSignal;
    onText: (delta: string) => void;
  }): Promise<TurnOutcome> {
    if (this.#phase === 'open' && this.#chat !== undefined) {
      const outcome = await this.#chat.turns.sendMessage({ text, signal, onText });
      if (outcome.kind === 'done') {
        this.#followUps += outcome.approvals.length;
      }
      return outcome;
    }
    if (this.#phase === 'closing') {
      return { kind: 'done', turnId: '', approvals: [] };
    }
    const answer = goodTimeAnswer(text);
    if (answer === 'yes') {
      const chat = await this.#openChat();
      if (chat === undefined) {
        return this.#close({ line: CALL_LINES.noChat, onText });
      }
      this.#chat = chat;
      this.#phase = 'open';
      onText(CALL_LINES.message(this.#message));
      return { kind: 'done', turnId: '', approvals: [] };
    }
    if (answer === 'no') {
      return this.#close({ line: CALL_LINES.notNow, onText });
    }
    this.#unclear += 1;
    if (this.#unclear >= 2) {
      return this.#close({ line: CALL_LINES.giveUp, onText });
    }
    onText(CALL_LINES.askAgain);
    return { kind: 'done', turnId: '', approvals: [] };
  }

  /** Never answered on a call: the card stays waiting in the app, whatever was heard. */
  answerApproval(): Promise<TurnOutcome> {
    return Promise.resolve({ kind: 'refused', reason: 'not_allowed' });
  }

  async cancel(): Promise<void> {
    await this.#chat?.turns.cancel();
  }

  #close({ line, onText }: { line: string; onText: (delta: string) => void }): TurnOutcome {
    this.#phase = 'closing';
    onText(line);
    this.#hangUp();
    return { kind: 'done', turnId: '', approvals: [] };
  }
}
