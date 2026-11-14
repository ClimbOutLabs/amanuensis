import { createHash, randomBytes } from 'node:crypto';

import type { Logger } from 'winston';
import type { RawData, WebSocket } from 'ws';

import type { IDeliveryStore } from '../../db/deliveryStore';
import type { IPersonalizationStore } from '../../db/personalizationStore';
import type { IPhoneCallStore } from '../../db/phoneCallStore';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { ITextContactStore } from '../../db/textContactStore';
import type { Delivery, DeliveryAttempt, DeliveryChannel } from '../../schemas/deliveries';
import {
  CallStatusParamsSchema,
  VoiceWebhookParamsSchema,
  type PhoneCall,
  type PhoneCallOutcome,
} from '../../schemas/phoneCalls';
import { newId } from '../../utils/id';
import { PhoneVoiceTransport, readPhoneFrame } from '../../voice/phoneTransport';
import { VoiceSession, type VoiceSessionDeps } from '../../voice/session';
import type { DeliveryChannelSender } from '../delivery/deliveryChannel';
import type { DeliveryService } from '../delivery/deliveryService';
import { maskedTarget } from '../texts/smsSender';
import { canText } from '../texts/textNumber';
import { allowedExtraWords, privatePhrase } from '../texts/textWords';
import { callName } from './callName';
import { CALL_LINES, CallTurns, type CallChat } from './callTurns';
import { callVoiceProblem, type CallVoice } from './callVoiceReady';
import { messageLine } from './callWords';
import { claimTestCall } from './testCallClaim';
import { callFailureWords, MEDIA_STREAM_PATH, type CallProvider } from './twilioCalls';

/** Said where calls are offered while this server has no Twilio account. */
export const CALLS_NOT_SET_UP =
  'Calls are not set up on this server. To set them up, add the Twilio details to the settings file and restart Aman.';

/** A phone that never rang is told through these instead, once, as a nudge. */
const CALL_FALLBACK_CHANNELS: readonly DeliveryChannel[] = ['sms', 'web_push', 'telegram'];

/**
 * Twilio's requests for a call are refused after this, and no media session can open. Twilio rings for 25 seconds and
 * its requests follow within a minute, so a call it never confirmed is ended, and texted about, soon after.
 */
const CALL_LIFETIME_MS = 2 * 60_000;
/** A media token must be used within this long of Twilio being told about it. */
const MEDIA_TOKEN_TTL_MS = 30_000;
/** Twilio sends `start` within milliseconds of the socket opening; a socket that names no call by then is closed. */
const START_WAIT_MS = 3_000;
/**
 * More lines than this waiting to name their call are not real calls. The one that has waited longest is closed to
 * make room. Each call has its own signed address, so only a signature Twilio made for a live call can fill places.
 */
const MAX_WAITING_LINES = 8;
/** Ended calls are kept this long, then forgotten. */
const KEEP_ENDED_MS = 30 * 24 * 60 * 60_000;

/** How long a call may go on. Each can be shortened for a test. */
export interface CallLimits {
  /** The assistant says goodbye after this much talking. */
  talkMs: number;
  /** The line is closed this long after goodbye was due, whatever is still running. */
  hangUpGraceMs: number;
  /** Silence after the question counts as an answer that was not caught. */
  silenceMs: number;
}

const DEFAULT_LIMITS: CallLimits = { talkMs: 10 * 60_000, hangUpGraceMs: 15_000, silenceMs: 8_000 };

/** Twilio's final statuses for a call that never reached a person. */
const MISSED_STATUSES = new Set(['busy', 'no-answer', 'failed', 'canceled']);

const HANG_UP_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';

/**
 * What Activity says about how a call ended. Each sentence is one idea. A call that ends without a conversation gets
 * one more sentence from `endWithoutTalking`: what was sent instead, or for a test, that it was not tried again.
 */
const ENDED_WORDS = {
  noAnswer: 'No one answered.',
  voicemail: 'A voicemail picked up, so a short message was left. It said only that something needs you.',
  voicemailNotLeft: 'A voicemail picked up, but no message could be left.',
  lineNotOpened: 'The call was answered, but the line could not be opened.',
  messageNotSaid: 'You answered, but the message could not be read out.',
  cutOff: 'The call stopped before it finished.',
  noOneSpoke: 'The call was answered, but no one spoke, so it may have been a voicemail.',
  saidNo: 'You answered and said it was not a good time. It is waiting for you in the app.',
  noYes: 'You answered, but the call ended before you said it was a good time. It is waiting for you in the app.',
  noChat: 'You answered, but the assistant could not talk it through on the phone. It is waiting for you in the app.',
  ended: 'You answered. The call ended.',
  endedInChat: 'You answered. The call ended. Anything that was said is in the chat.',
} as const;

/** What a call listens with. It speaks with the voice service's default voice. */
export type CallListening = Pick<VoiceSessionDeps, 'vad' | 'stt'>;
type CallSpeaking = VoiceSessionDeps['tts'];

/** The names a call says: the assistant's, and the person's, each from their settings and undefined when unset. */
export interface CallNames {
  assistant: string | undefined;
  person: string | undefined;
  /** The words a call may say besides the word list, as for a text: the person's added words and the assistant's name. */
  words: ReadonlySet<string>;
}

/** Opens the chat a call's conversation is written in, as the person, starting with the assistant's opening line. */
export interface CallChats {
  open(input: {
    owner: { tenant_id: string; created_by: string };
    names: CallNames;
    delivery: Delivery;
    call_id: string;
    opening: string;
  }): Promise<CallChat | undefined>;
}

export interface PhoneCallService {
  /** The delivery channel: a delivery that may call rings the person's confirmed number. */
  readonly sender: DeliveryChannelSender;
  /** Twilio's voice webhook: what to do now the call was answered. Resolves to TwiML. */
  answered(input: { params: URLSearchParams; query: URLSearchParams }): Promise<string>;
  /** Twilio's status webhook: how the call stands. */
  statusChanged(input: { params: URLSearchParams; query: URLSearchParams }): Promise<void>;
  /** Whether a call is waiting for its stream: placed here and not yet ended. Checked before the socket opens. */
  mayStream(call_id: string): Promise<boolean>;
  /** A media WebSocket Twilio opened at the address of this call. It must carry the call's one-time token. */
  media(input: { socket: WebSocket; call_id: string }): void;
  /** Ends calls that never finished, such as one cut off when the server stopped, and forgets old ones. */
  sweep(): Promise<void>;
}

interface PhoneCallDeps {
  store: IPhoneCallStore;
  deliveryStore: Pick<IDeliveryStore, 'get'>;
  contacts: Pick<ITextContactStore, 'get' | 'listWords' | 'claimTextSends' | 'forgetTextSends'>;
  reachSettings: Pick<IReachSettingsStore, 'get'>;
  personalization: Pick<IPersonalizationStore, 'getProfile'>;
  /** Undefined when this server has no Twilio account. */
  twilio:
    | {
        provider: CallProvider;
        accountSid: string;
        /** The public https address of the Twilio listener, without a trailing slash. */
        publicUrl: string;
      }
    | undefined;
  /** Whether the parts that listen and speak are running now. */
  voice: () => Promise<CallVoice>;
  /** Read when needed: the delivery service is made after its channels. */
  deliveries: () => Pick<DeliveryService, 'fallBack' | 'recordAttempt'>;
  chats: CallChats;
  /** The voice for a call to this person; a voicemail needs only this. */
  speaking: (owner: { tenant_id: string; created_by: string }) => CallSpeaking;
  /** What a conversation listens with, loaded once the person is on the line. */
  listening: () => Promise<CallListening>;
  logger: Logger;
  limits?: Partial<CallLimits>;
  /** Starts the wait for an answer and returns how to cancel it; a test supplies its own to control when it runs out. */
  startSilence?: (fire: () => void, ms: number) => () => void;
  now?: () => Date;
  newToken?: () => string;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function xmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function minutesWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? 'about a minute' : `about ${String(minutes)} minutes`;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** One open line, from the socket's first frame to its close. `end` runs once, however the line ends. */
interface CallLine {
  start(): Promise<void>;
  end(): Promise<void>;
  audio(bytes: Uint8Array): void;
}

export function createPhoneCallService(deps: PhoneCallDeps): PhoneCallService {
  const now = deps.now ?? (() => new Date());
  const newToken = deps.newToken ?? (() => randomBytes(32).toString('base64url'));
  const limits: CallLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const startSilence =
    deps.startSilence ??
    ((fire: () => void, ms: number) => {
      const timer = setTimeout(fire, ms);
      return () => {
        clearTimeout(timer);
      };
    });
  const { store, logger } = deps;
  const twilio = deps.twilio;
  const streamUrlFor = (call_id: string): string | undefined =>
    twilio === undefined
      ? undefined
      : `${twilio.publicUrl.replace(/^https:/, 'wss:')}${MEDIA_STREAM_PATH}/${encodeURIComponent(call_id)}`;
  /** Calls with an open line in this process; their own close writes them down. */
  const live = new Set<string>();
  /** Lines open but not yet named, oldest first. */
  const waitingLines = new Set<WebSocket>();

  const attempt = ({
    outcome,
    detail,
    target,
  }: {
    outcome: DeliveryAttempt['outcome'];
    detail: string;
    target: string | null;
  }): DeliveryAttempt => ({ channel: 'call', outcome, detail, target, attempted_at: now().toISOString() });

  /** The same rule as a text: plain letters only, kept short, and never a name that holds a phone number. */
  async function namesFor(owner: { tenant_id: string; created_by: string }): Promise<CallNames> {
    const profile = await deps.personalization.getProfile(owner);
    const assistant = callName(profile?.assistant_name);
    return {
      assistant,
      person: callName(profile?.address_as ?? profile?.user_name),
      words: await allowedExtraWords({ contacts: deps.contacts, owner, name: assistant ?? '' }),
    };
  }

  function spokenName(names: CallNames): string {
    return names.assistant ?? 'your assistant';
  }

  function deliveryOf(call: PhoneCall): Promise<Delivery | undefined> {
    return deps.deliveryStore.get({ tenant_id: call.tenant_id, created_by: call.created_by, id: call.delivery_id });
  }

  /**
   * A call that never got to a conversation: written down once, then one text and one push. It is never tried again.
   */
  async function endWithoutTalking({
    call,
    outcome,
    detail,
  }: {
    call: PhoneCall;
    outcome: Extract<PhoneCallOutcome, 'voicemail' | 'no_answer' | 'failed'>;
    detail: string;
  }): Promise<void> {
    const owner = { tenant_id: call.tenant_id, created_by: call.created_by };
    if (!(await store.finish({ id: call.id, outcome, now: now() }))) {
      return;
    }
    const instead =
      call.fallback === 'off' ? 'The call was not tried again.' : 'It was sent as a text and a notice instead.';
    await deps.deliveries().recordAttempt({
      ...owner,
      delivery_id: call.delivery_id,
      attempt: attempt({
        outcome: outcome === 'voicemail' ? 'sent' : 'failed',
        detail: `${detail} ${instead}`,
        target: null,
      }),
    });
    if (await store.claimFallback(call.id)) {
      await deps.deliveries().fallBack({ ...owner, delivery_id: call.delivery_id, channels: CALL_FALLBACK_CHANNELS });
    }
  }

  /** A call the person answered, written down once with how it went. */
  async function endAnswered({
    call,
    outcome,
    detail,
    session_id,
  }: {
    call: PhoneCall;
    outcome: Extract<PhoneCallOutcome, 'answered' | 'not_now'>;
    detail: string;
    session_id: string | null | undefined;
  }): Promise<void> {
    if (!(await store.finish({ id: call.id, outcome, now: now() }))) {
      return;
    }
    await deps.deliveries().recordAttempt({
      tenant_id: call.tenant_id,
      created_by: call.created_by,
      delivery_id: call.delivery_id,
      attempt: attempt({ outcome: 'sent', detail, target: null }),
      ...(session_id === undefined || session_id === null ? {} : { conversation_id: session_id }),
    });
  }

  /** Rings the person for a delivery already in their feed. A Try it test is limited, and never texts. */
  async function place({
    owner,
    delivery,
    test,
  }: {
    owner: { tenant_id: string; created_by: string };
    delivery: Delivery;
    test: boolean;
  }): Promise<DeliveryAttempt> {
    if (twilio === undefined) {
      return attempt({ outcome: 'skipped', detail: CALLS_NOT_SET_UP, target: null });
    }
    const voice = await deps.voice();
    if (voice !== 'ready') {
      return attempt({ outcome: 'skipped', detail: callVoiceProblem(voice), target: null });
    }
    const settings = await deps.reachSettings.get(owner);
    if (settings?.channels.calls !== true) {
      return attempt({
        outcome: 'skipped',
        detail: 'Calls are switched off. Switch them on in Settings, Reach me.',
        target: null,
      });
    }
    const contact = await deps.contacts.get(owner);
    if (!canText(contact)) {
      return attempt({
        outcome: 'skipped',
        detail: 'Your number is not confirmed, so no call was made. Confirm it in Settings, Reach me.',
        target: null,
      });
    }
    const target = maskedTarget(contact.phone);
    const at = now();
    if (test) {
      // Claimed only once the call can ring, so a test turned away for any other reason counts nowhere.
      const claim = await claimTestCall({ store: deps.contacts, owner, at });
      if (!claim.ok) {
        return attempt({ outcome: 'skipped', detail: claim.message, target: null });
      }
    }
    const call = await store.create({
      id: newId(),
      ...owner,
      delivery_id: delivery.id,
      fallback: !test,
      now: at,
      expires_at: new Date(at.getTime() + CALL_LIFETIME_MS),
    });
    const result = await twilio.provider.place({ to: contact.phone, call_id: call.id });
    if (result.outcome === 'failed') {
      await store.finish({ id: call.id, outcome: 'failed', now: now() });
      return attempt({ outcome: 'failed', detail: callFailureWords({ failure: result.failure, test }), target });
    }
    if (result.outcome === 'unknown') {
      // Twilio may have started the call. Ending it here would text the person and then hang up on them when it rings,
      // so the call is left open: Twilio's requests name it by Aman's own id, and the sweep ends it if none come.
      logger.warn('A phone call may have started without Twilio saying so', { call_id: call.id });
      return attempt({
        outcome: 'sent',
        detail: test
          ? 'Twilio did not confirm the call. If your phone does not ring in 2 minutes, try again.'
          : 'Twilio did not confirm the call. If it does not ring, a text and a notice follow in about 2 minutes.',
        target,
      });
    }
    try {
      await store.attachSid({ id: call.id, call_sid: result.call_sid });
    } catch (error) {
      // The phone is ringing whatever happened here: Twilio's requests name the call by Aman's own id too.
      logger.warn('A phone call id could not be saved', { call_id: call.id, error: errorName(error) });
    }
    // Only the outcome is logged: the number and what the call is about are the person's.
    logger.info('A phone call was started', { call_id: call.id });
    return attempt({ outcome: 'sent', detail: 'The phone is ringing.', target });
  }

  const sender: DeliveryChannelSender = {
    channel: 'call',
    fallsBackTo: CALL_FALLBACK_CHANNELS,
    async send({ delivery, tenant_id, created_by, test }) {
      if (!test && delivery.level !== 'call') {
        return [];
      }
      return [await place({ owner: { tenant_id, created_by }, delivery, test })];
    },
  };

  /**
   * The call a Twilio request is about: by Twilio's id, or else by Aman's own id in the signed address, for a call
   * whose Twilio id was never saved.
   */
  async function callFor({ sid, query }: { sid: string; query: URLSearchParams }): Promise<PhoneCall | undefined> {
    const bySid = await store.getBySid(sid);
    if (bySid !== undefined) {
      return bySid;
    }
    const id = query.get('call');
    const byId = id === null ? undefined : await store.get(id);
    if (byId?.call_sid !== null) {
      return undefined;
    }
    await store.attachSid({ id: byId.id, call_sid: sid });
    return store.get(byId.id);
  }

  async function answered({ params, query }: { params: URLSearchParams; query: URLSearchParams }): Promise<string> {
    const parsed = VoiceWebhookParamsSchema.safeParse(Object.fromEntries(params));
    if (twilio === undefined || !parsed.success) {
      return HANG_UP_TWIML;
    }
    const { AccountSid, CallSid, AnsweredBy = 'unknown' } = parsed.data;
    if (AccountSid !== twilio.accountSid) {
      return HANG_UP_TWIML;
    }
    const call = await callFor({ sid: CallSid, query });
    if (call === undefined) {
      return HANG_UP_TWIML;
    }
    if (AnsweredBy === 'fax') {
      await endWithoutTalking({ call, outcome: 'no_answer', detail: ENDED_WORDS.noAnswer });
      return HANG_UP_TWIML;
    }
    const streamUrl = streamUrlFor(call.id);
    if (streamUrl === undefined) {
      return HANG_UP_TWIML;
    }
    const token = newToken();
    const issued = await store.issueToken({
      call_sid: CallSid,
      token_hash: tokenHash(token),
      token_expires_at: new Date(now().getTime() + MEDIA_TOKEN_TTL_MS),
      mode: AnsweredBy.startsWith('machine') ? 'voicemail' : 'talk',
      now: now(),
    });
    if (!issued) {
      return HANG_UP_TWIML;
    }
    // The conversation is spoken through the stream in the assistant's own voice; Twilio's own speech is never used.
    return (
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect>' +
      `<Stream url="${xmlAttribute(streamUrl)}"><Parameter name="token" value="${xmlAttribute(token)}"/></Stream>` +
      '</Connect></Response>'
    );
  }

  async function statusChanged({ params, query }: { params: URLSearchParams; query: URLSearchParams }): Promise<void> {
    const parsed = CallStatusParamsSchema.safeParse(Object.fromEntries(params));
    if (!parsed.success || parsed.data.AccountSid !== twilio?.accountSid) {
      return;
    }
    const { CallSid, CallStatus } = parsed.data;
    const call = await callFor({ sid: CallSid, query });
    if (call === undefined || call.status === 'ended') {
      return;
    }
    const lineGiven = call.status === 'connecting' || call.status === 'connected';
    if (MISSED_STATUSES.has(CallStatus) || (CallStatus === 'completed' && !lineGiven)) {
      await endWithoutTalking({ call, outcome: 'no_answer', detail: ENDED_WORDS.noAnswer });
      return;
    }
    if (CallStatus !== 'completed' || live.has(call.id)) {
      // A line open in this process writes itself down when it closes.
      return;
    }
    if (call.status === 'connecting') {
      await endWithoutTalking({ call, outcome: 'failed', detail: ENDED_WORDS.lineNotOpened });
    } else if (call.mode === 'voicemail') {
      await endWithoutTalking({ call, outcome: 'voicemail', detail: ENDED_WORDS.voicemail });
    } else {
      await endAnswered({
        call,
        outcome: 'answered',
        detail: call.session_id === null ? ENDED_WORDS.ended : ENDED_WORDS.endedInChat,
        session_id: call.session_id,
      });
    }
  }

  function voicemailLine({ call, transport }: { call: PhoneCall; transport: PhoneVoiceTransport }): CallLine {
    let left = false;
    let ending: Promise<void> | undefined;
    // Stops the voice once the line is gone, so nothing is spoken into a closed call.
    const abort = new AbortController();
    return {
      async start() {
        try {
          const text = CALL_LINES.voicemail(spokenName(await namesFor(call)));
          // Said only as written, or not at all: a voicemail is heard by whoever plays it back.
          const voice = deps
            .speaking({ tenant_id: call.tenant_id, created_by: call.created_by })
            .stream({ text, format: 'mulaw8k', signal: abort.signal, exact: true });
          for await (const chunk of voice) {
            transport.sendAudio(chunk);
          }
          await transport.whenPlayed();
          left = true;
        } catch (error) {
          logger.warn('A voicemail could not be spoken', { call_id: call.id, error: errorName(error) });
        } finally {
          transport.close();
        }
      },
      end() {
        abort.abort();
        ending ??= endWithoutTalking({
          call,
          outcome: 'voicemail',
          detail: left ? ENDED_WORDS.voicemail : ENDED_WORDS.voicemailNotLeft,
        });
        return ending;
      },
      audio() {
        // A voicemail only speaks.
      },
    };
  }

  function talkLine({
    call,
    socket,
    transport,
  }: {
    call: PhoneCall;
    socket: WebSocket;
    transport: PhoneVoiceTransport;
  }): CallLine {
    const owner = { tenant_id: call.tenant_id, created_by: call.created_by };
    const timers: NodeJS.Timeout[] = [];
    let talking: { session: VoiceSession; turns: CallTurns; startedAt: Date } | undefined;
    let ended = false;
    /** Why the call was not heard through, when the voice could not say the opening or the message. */
    let unheard: string | undefined;
    /** The wait for an answer, while one is running. */
    let cancelSilence: (() => void) | undefined;
    let ending: Promise<void> | undefined;
    /** The conversation opened by a yes. */
    let opened: CallChat | undefined;
    /** The chat being written, once the person heard the message; it resolves to the chat's id when one was written. */
    let written: Promise<string | undefined> | undefined;

    const writeChat = async (): Promise<string | undefined> => {
      try {
        const session_id = await opened?.begin();
        if (session_id !== undefined) {
          await store.setSession({ id: call.id, session_id });
        }
        return session_id;
      } catch (error) {
        logger.warn('A phone call chat could not be written', { call_id: call.id, error: errorName(error) });
        return undefined;
      }
    };

    const later = (ms: number, run: () => void): void => {
      timers.push(setTimeout(run, ms));
    };

    /** Work that runs on its own. If it fails, this call ends and nothing else is touched. */
    const alone = (work: Promise<unknown>): void => {
      work.catch((error: unknown) => {
        logger.warn('A phone call step failed', { call_id: call.id, error: errorName(error) });
        socket.terminate();
      });
    };

    async function begin(): Promise<void> {
      const loading = deps.listening();
      const release = (): Promise<void> =>
        loading.then(
          parts => parts.vad.dispose?.().catch(() => undefined),
          () => undefined,
        );
      let read: [Delivery | undefined, CallNames, CallListening];
      try {
        read = await Promise.all([deliveryOf(call), namesFor(owner), loading]);
      } catch (error) {
        await release();
        throw error;
      }
      const [delivery, names, listening] = read;
      if (ended) {
        await release();
        return;
      }
      const name = spokenName(names);
      const hangUp = (): void => {
        alone(
          (async () => {
            await talking?.session.settled();
            await transport.whenPlayed();
            transport.close();
          })(),
        );
      };
      /** Waits for the person to answer the question; silence counts as an answer that was not caught. */
      const listenForAnswer = (): void => {
        if (ended) {
          return;
        }
        const heard = turns.replies;
        cancelSilence?.();
        cancelSilence = startSilence(() => {
          cancelSilence = undefined;
          if (turns.replies !== heard) {
            return;
          }
          const next = turns.heardNothing();
          if (next === undefined) {
            return;
          }
          alone(
            session
              .say(next.line)
              .then(() => transport.whenPlayed())
              .then(() => {
                if (ended) {
                  return;
                }
                if (next.end) {
                  transport.close();
                } else {
                  listenForAnswer();
                }
              }),
          );
        }, limits.silenceMs);
      };
      /** The person heard nothing of why they were called, so a text and a push tell them instead. */
      const notHeard = (words: string): void => {
        if (ended) {
          return;
        }
        unheard = words;
        alone(
          transport.whenPlayed().then(() => {
            transport.close();
          }),
        );
      };
      const turns = new CallTurns({
        message: delivery === undefined ? 'It is in the app for you to see.' : messageLine(delivery, names.words),
        openChat: async () => {
          if (delivery === undefined) {
            return undefined;
          }
          const chat = await deps.chats.open({
            owner,
            names,
            delivery,
            call_id: call.id,
            opening: `Hi, this is ${name}. ${messageLine(delivery, names.words)}`,
          });
          opened = chat;
          return chat;
        },
        hangUp,
        failed: error => {
          logger.warn('A phone call turn failed', { call_id: call.id, error: errorName(error) });
        },
        // Said in the voice's own reading, like every reply after it: a reminder is written for the screen, and a
        // check that it reads word for word would refuse many of them while protecting nothing on an answered call.
        sayMessage: line => {
          alone(
            session.say(line).then(said => {
              if (!said) {
                notHeard(ENDED_WORDS.messageNotSaid);
                return;
              }
              // A line that was hung up on while it spoke was already written down without a chat.
              if (!ended) {
                written ??= writeChat();
              }
            }),
          );
        },
        askedAgain: () => {
          alone(
            session
              .settled()
              .then(() => transport.whenPlayed())
              .then(listenForAnswer),
          );
        },
      });
      const session = new VoiceSession({
        ...listening,
        tts: deps.speaking(owner),
        transport,
        turns,
        // Timings and reason codes only: what was said is never logged.
        onLatency: latency => {
          logger.info('phone call turn', latency);
        },
        onNote: note => {
          logger.info('phone call note', { note });
        },
        // Someone who starts to answer just before the wait runs out is not talked over.
        onSpeechStarted: () => {
          if (cancelSilence !== undefined) {
            listenForAnswer();
          }
        },
      });
      talking = { session, turns, startedAt: now() };
      session.start();
      const opening = CALL_LINES.opening({
        name,
        person: names.person,
        kind: delivery === undefined ? 'something needs you' : privatePhrase(delivery.kind),
      });
      // The opening plays to the end, and only as written. A reply that starts over it is not an answer.
      alone(
        session.say(opening, { interruptible: false, exact: true }).then(async said => {
          if (!said) {
            notHeard(ENDED_WORDS.lineNotOpened);
            return;
          }
          await transport.whenPlayed();
          listenForAnswer();
        }),
      );
      later(limits.talkMs, () => {
        alone(session.say(CALL_LINES.timeUp).then(hangUp));
      });
      // The line closes whatever is still running, so a stuck reply cannot hold the call open.
      later(limits.talkMs + limits.hangUpGraceMs, () => {
        socket.terminate();
      });
    }

    return {
      async start() {
        try {
          await begin();
        } catch (error) {
          logger.warn('A phone call could not start', { call_id: call.id, error: errorName(error) });
          socket.close(1011, 'could not start');
        }
      },
      end() {
        ending ??= (async () => {
          ended = true;
          timers.forEach(clearTimeout);
          cancelSilence?.();
          if (talking === undefined || unheard !== undefined) {
            await talking?.session.end();
            // The person never heard the assistant, so they hear through a text and a push instead.
            await endWithoutTalking({ call, outcome: 'failed', detail: unheard ?? ENDED_WORDS.lineNotOpened });
            return;
          }
          const { session, turns, startedAt } = talking;
          await session.end();
          if (turns.ending === 'unclear' && turns.replies === 0) {
            // Silence to the question and to it asked again: likely a voicemail the answering check did not catch.
            await endWithoutTalking({ call, outcome: 'no_answer', detail: ENDED_WORDS.noOneSpoke });
            return;
          }
          const session_id = await written;
          const lasted = `The call lasted ${minutesWords(now().getTime() - startedAt.getTime())}`;
          const said =
            session_id !== undefined
              ? `You answered. ${lasted}, and what was said is in the chat.`
              : turns.chat !== undefined
                ? `You answered. ${lasted}.`
                : turns.ending === 'said_no'
                  ? ENDED_WORDS.saidNo
                  : turns.ending === 'no_chat'
                    ? ENDED_WORDS.noChat
                    : ENDED_WORDS.noYes;
          await endAnswered({
            call,
            outcome: turns.answered ? 'answered' : 'not_now',
            detail: said,
            session_id,
          });
        })();
        return ending;
      },
      audio(bytes) {
        talking?.session.pushAudio(bytes);
      },
    };
  }

  async function mayStream(call_id: string): Promise<boolean> {
    const call = await store.get(call_id);
    return call?.status === 'connecting';
  }

  function media({ socket, call_id }: { socket: WebSocket; call_id: string }): void {
    let line: { call: PhoneCall; run: CallLine; transport: PhoneVoiceTransport } | undefined;
    let started = false;
    let closed = false;
    if (waitingLines.size >= MAX_WAITING_LINES) {
      const [oldest] = waitingLines;
      if (oldest !== undefined) {
        waitingLines.delete(oldest);
        oldest.close(1013, 'busy');
      }
    }
    waitingLines.add(socket);
    const stopWaiting = (): void => {
      waitingLines.delete(socket);
    };
    const waitForStart = setTimeout(() => {
      socket.close(1008, 'no call');
    }, START_WAIT_MS);
    const writeDown = ({ call, run }: { call: PhoneCall; run: CallLine }): void => {
      run
        .end()
        .catch((error: unknown) => {
          logger.warn('A phone call could not be written down', { call_id: call.id, error: errorName(error) });
        })
        .finally(() => {
          live.delete(call.id);
        });
    };
    // Attached before anything is awaited, so a line that drops at any point is still written down.
    socket.on('close', () => {
      closed = true;
      stopWaiting();
      clearTimeout(waitForStart);
      if (line !== undefined) {
        writeDown(line);
      }
    });
    const onFrame = (data: RawData): void => {
      const frame = readPhoneFrame(data);
      if (frame.kind === 'audio') {
        line?.run.audio(frame.bytes);
        return;
      }
      if (frame.kind === 'mark') {
        line?.transport.onMark(frame.name);
        return;
      }
      if (frame.kind === 'stop') {
        socket.close(1000, 'stopped');
        return;
      }
      if (frame.kind !== 'start' || started) {
        return;
      }
      started = true;
      stopWaiting();
      clearTimeout(waitForStart);
      const token = frame.parameters['token'];
      void (async () => {
        const call =
          token === undefined
            ? undefined
            : await store.redeemToken({ call_sid: frame.callSid, token_hash: tokenHash(token), now: now() });
        if (call?.id !== call_id) {
          // Only the fact is logged: an unknown, used or expired token opens nothing.
          logger.warn('A media session was refused: it did not name a call Aman started');
          socket.close(1008, 'unknown call');
          return;
        }
        live.add(call.id);
        const transport = new PhoneVoiceTransport({ socket, streamSid: frame.streamSid });
        const run =
          call.mode === 'voicemail' ? voicemailLine({ call, transport }) : talkLine({ call, socket, transport });
        line = { call, run, transport };
        if (closed) {
          writeDown(line);
          return;
        }
        await run.start();
      })().catch((error: unknown) => {
        logger.warn('A phone call could not start', { error: errorName(error) });
        socket.close(1011, 'could not start');
      });
    };
    socket.on('message', data => {
      try {
        onFrame(data);
      } catch (error) {
        logger.warn('A phone call frame could not be handled', { call_id, error: errorName(error) });
        socket.terminate();
      }
    });
  }

  async function sweep(): Promise<void> {
    const at = now().getTime();
    // A call that never reached its line is over once it expires; one that did is over once its longest talk is.
    const longest = CALL_LIFETIME_MS + limits.talkMs + limits.hangUpGraceMs + 60_000;
    for (const call of await store.listUnfinished({ created_before: new Date(at - CALL_LIFETIME_MS) })) {
      const lineGiven = call.status === 'connecting' || call.status === 'connected';
      const over = lineGiven ? Date.parse(call.created_at) + longest < at : Date.parse(call.expires_at) < at;
      if (over && !live.has(call.id)) {
        await endWithoutTalking(
          lineGiven
            ? { call, outcome: 'failed', detail: ENDED_WORDS.cutOff }
            : { call, outcome: 'no_answer', detail: ENDED_WORDS.noAnswer },
        );
      }
    }
    await store.prune({ ended_before: new Date(at - KEEP_ENDED_MS) });
  }

  return { sender, answered, statusChanged, mayStream, media, sweep };
}
