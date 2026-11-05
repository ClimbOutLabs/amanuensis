import { createHash, randomBytes } from 'node:crypto';

import type { Logger } from 'winston';
import type { WebSocket } from 'ws';

import type { IDeliveryStore } from '../../db/deliveryStore';
import type { IPersonalizationStore } from '../../db/personalizationStore';
import type { IPhoneCallStore } from '../../db/phoneCallStore';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { ITextContactStore } from '../../db/textContactStore';
import type { Delivery, DeliveryAttempt } from '../../schemas/deliveries';
import type { PhoneCall, PhoneCallOutcome } from '../../schemas/phoneCalls';
import { newId } from '../../utils/id';
import { PhoneVoiceTransport, readPhoneFrame } from '../../voice/phoneTransport';
import { VoiceSession, type VoiceSessionDeps } from '../../voice/session';
import type { DeliveryChannelSender } from '../delivery/deliveryChannel';
import type { DeliveryService } from '../delivery/deliveryService';
import { assistantNameFor, FALLBACK_ASSISTANT_NAME } from '../texts/assistantName';
import { maskedTarget, privatePhrase } from '../texts/smsSender';
import { canText } from '../texts/textNumber';
import { CALL_LINES, CallTurns, type CallChat } from './callTurns';
import { callFailureWords, MEDIA_STREAM_PATH, type CallProvider } from './twilioCalls';

/** Twilio's requests for a call are refused after this, and no media session can open. */
const CALL_LIFETIME_MS = 5 * 60_000;
/** A media token must be used within this long of Twilio being told about it. */
const MEDIA_TOKEN_TTL_MS = 30_000;
/** Twilio sends `start` straight after the socket opens; a socket that names no call by then is closed. */
const START_WAIT_MS = 10_000;
/** The longest a call talks before the assistant says goodbye. */
const MAX_TALK_MS = 10 * 60_000;
/** The most of the assistant's name read aloud, so a long name cannot fill the call. */
const SPOKEN_NAME_MAX = 40;

/** Twilio's final statuses for a call that never reached a person. */
const MISSED_STATUSES = new Set(['busy', 'no-answer', 'failed', 'canceled']);

export const HANG_UP_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';

/** The parts a call listens and speaks with; the same ones a voice session in the app uses. */
export type CallVoiceParts = Pick<VoiceSessionDeps, 'vad' | 'stt' | 'tts'>;

/** Opens the chat a call's conversation is written in, as the person, starting with the assistant's opening line. */
export interface CallChats {
  open(input: {
    owner: { tenant_id: string; created_by: string };
    delivery: Delivery;
    call_id: string;
    opening: string;
  }): Promise<CallChat | undefined>;
}

export interface PhoneCallService {
  /** The delivery channel: a delivery that may call rings the person's confirmed number. */
  readonly sender: DeliveryChannelSender;
  /** Rings the person for a delivery already in their feed. `fallback: false` for a test, which never texts. */
  place(input: {
    owner: { tenant_id: string; created_by: string };
    delivery: Delivery;
    fallback: boolean;
  }): Promise<DeliveryAttempt>;
  /** Twilio's voice webhook: what to do now the call was answered. Resolves to TwiML. */
  answered(params: URLSearchParams): Promise<string>;
  /** Twilio's status webhook: how the call ended. */
  statusChanged(params: URLSearchParams): Promise<void>;
  /** A media WebSocket Twilio opened. It must name a call Aman started, with its one-time token. */
  media(socket: WebSocket): void;
}

export interface PhoneCallDeps {
  store: IPhoneCallStore;
  deliveryStore: Pick<IDeliveryStore, 'get'>;
  contacts: Pick<ITextContactStore, 'get'>;
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
  /** Read when needed: the delivery service is made after its channels. */
  deliveries: () => Pick<DeliveryService, 'fallBack' | 'recordAttempt'>;
  chats: CallChats;
  parts: () => Promise<CallVoiceParts>;
  logger: Logger;
  now?: () => Date;
  newToken?: () => string;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function xmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The name the call speaks: the person's own choice, kept short. */
function spokenName(name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim();
  return flat.length <= SPOKEN_NAME_MAX ? flat : flat.slice(0, SPOKEN_NAME_MAX).trimEnd();
}

/** What the call says the delivery is about once the person said yes. */
function spokenMessage(delivery: Delivery): string {
  return delivery.kind === 'reminder' ? `Here is your reminder: ${delivery.text}` : delivery.text;
}

function minutesWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? 'about a minute' : `about ${String(minutes)} minutes`;
}

export function createPhoneCallService(deps: PhoneCallDeps): PhoneCallService {
  const now = deps.now ?? (() => new Date());
  const newToken = deps.newToken ?? (() => randomBytes(32).toString('base64url'));
  const { store, logger } = deps;
  const twilio = deps.twilio;
  const streamUrl =
    twilio === undefined ? undefined : `${twilio.publicUrl.replace(/^https:/, 'wss:')}${MEDIA_STREAM_PATH}`;

  const attempt = ({
    outcome,
    detail,
    target,
  }: {
    outcome: DeliveryAttempt['outcome'];
    detail: string;
    target: string | null;
  }): DeliveryAttempt => ({ channel: 'call', outcome, detail, target, attempted_at: now().toISOString() });

  async function nameFor(owner: { tenant_id: string; created_by: string }): Promise<string> {
    return spokenName(await assistantNameFor({ personalization: deps.personalization, owner }));
  }

  function deliveryOf(call: PhoneCall): Promise<Delivery | undefined> {
    return deps.deliveryStore.get({ tenant_id: call.tenant_id, created_by: call.created_by, id: call.delivery_id });
  }

  /** A call that never reached a person: written down once, then one text and one push. It is never tried again. */
  async function missed({ call, outcome }: { call: PhoneCall; outcome: 'voicemail' | 'no_answer' }): Promise<void> {
    const owner = { tenant_id: call.tenant_id, created_by: call.created_by };
    if (!(await store.finish({ id: call.id, outcome, follow_ups: 0, now: now() }))) {
      return;
    }
    await deps.deliveries().recordAttempt({
      ...owner,
      delivery_id: call.delivery_id,
      attempt: attempt({
        outcome: outcome === 'voicemail' ? 'sent' : 'failed',
        detail:
          outcome === 'voicemail'
            ? 'No one answered, so a short voicemail was left. It said only that something needs you. The call was not tried again.'
            : 'No one answered. The call was not tried again.',
        target: null,
      }),
    });
    if (await store.claimFallback(call.id)) {
      await deps.deliveries().fallBack({ ...owner, delivery_id: call.delivery_id, channels: ['sms', 'web_push'] });
    }
  }

  async function place({
    owner,
    delivery,
    fallback,
  }: {
    owner: { tenant_id: string; created_by: string };
    delivery: Delivery;
    fallback: boolean;
  }): Promise<DeliveryAttempt> {
    if (twilio === undefined) {
      return attempt({
        outcome: 'skipped',
        detail: 'Calls are not set up on this server. Add the Twilio settings and restart Aman.',
        target: null,
      });
    }
    const settings = await deps.reachSettings.get(owner);
    if (settings?.channels.calls !== true) {
      return attempt({ outcome: 'skipped', detail: 'Calls are switched off in Settings, Reach me.', target: null });
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
    const call = await store.create({
      id: newId(),
      ...owner,
      delivery_id: delivery.id,
      fallback,
      now: at,
      expires_at: new Date(at.getTime() + CALL_LIFETIME_MS),
    });
    const result = await twilio.provider.place({ to: contact.phone });
    if (result.outcome === 'failed') {
      await store.finish({ id: call.id, outcome: 'failed', follow_ups: 0, now: now() });
      return attempt({ outcome: 'failed', detail: callFailureWords(result.failure), target });
    }
    await store.attachSid({ id: call.id, call_sid: result.call_sid });
    // Only the outcome is logged: the number and what the call is about are the person's.
    logger.info('A phone call was started', { call_id: call.id });
    return attempt({ outcome: 'sent', detail: 'The phone is ringing.', target });
  }

  const sender: DeliveryChannelSender = {
    channel: 'call',
    async send({ delivery, tenant_id, created_by }) {
      if (delivery.level !== 'call') {
        return [];
      }
      const owner = { tenant_id, created_by };
      const started = await place({ owner, delivery, fallback: true });
      if (started.outcome !== 'sent') {
        // The phone never rang, so the person hears through a text and a push instead, once.
        await deps.deliveries().fallBack({ ...owner, delivery_id: delivery.id, channels: ['sms', 'web_push'] });
      }
      return [started];
    },
  };

  async function answered(params: URLSearchParams): Promise<string> {
    const sid = params.get('CallSid');
    if (
      twilio === undefined ||
      streamUrl === undefined ||
      params.get('AccountSid') !== twilio.accountSid ||
      sid === null
    ) {
      return HANG_UP_TWIML;
    }
    const call = await store.getBySid(sid);
    if (call === undefined) {
      return HANG_UP_TWIML;
    }
    const answeredBy = params.get('AnsweredBy') ?? 'unknown';
    if (answeredBy === 'fax') {
      await missed({ call, outcome: 'no_answer' });
      return HANG_UP_TWIML;
    }
    const token = newToken();
    const issued = await store.issueToken({
      call_sid: sid,
      token_hash: tokenHash(token),
      token_expires_at: new Date(now().getTime() + MEDIA_TOKEN_TTL_MS),
      mode: answeredBy.startsWith('machine') ? 'voicemail' : 'talk',
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

  async function statusChanged(params: URLSearchParams): Promise<void> {
    const sid = params.get('CallSid');
    if (params.get('AccountSid') !== twilio?.accountSid || sid === null) {
      return;
    }
    const call = await store.getBySid(sid);
    if (call === undefined || call.status === 'ended') {
      return;
    }
    const status = params.get('CallStatus') ?? '';
    // A call that ended before its line opened never reached the person, whatever Twilio calls it.
    if (MISSED_STATUSES.has(status) || (status === 'completed' && call.status !== 'connected')) {
      await missed({ call, outcome: 'no_answer' });
    }
  }

  async function leaveVoicemail({ call, transport }: { call: PhoneCall; transport: PhoneVoiceTransport }) {
    const owner = { tenant_id: call.tenant_id, created_by: call.created_by };
    const parts = await deps.parts();
    const text = CALL_LINES.voicemail(await nameFor(owner));
    const abort = new AbortController();
    try {
      for await (const chunk of parts.tts.stream({ text, format: 'mulaw8k', signal: abort.signal })) {
        transport.sendAudio(chunk);
      }
      await transport.whenPlayed();
    } catch (error) {
      logger.warn('A voicemail could not be spoken', {
        call_id: call.id,
        error: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      transport.close();
    }
    await missed({ call, outcome: 'voicemail' });
  }

  async function talk({
    call,
    socket,
    transport,
  }: {
    call: PhoneCall;
    socket: WebSocket;
    transport: PhoneVoiceTransport;
  }): Promise<(bytes: Uint8Array) => void> {
    const owner = { tenant_id: call.tenant_id, created_by: call.created_by };
    const delivery = await deliveryOf(call);
    const name = await nameFor(owner);
    const greetingName = name === FALLBACK_ASSISTANT_NAME ? name.toLowerCase() : name;
    const parts = await deps.parts();
    const startedAt = now();
    const hangUp = (): void => {
      void (async () => {
        await session.settled();
        await transport.whenPlayed();
        transport.close();
      })();
    };
    const turns = new CallTurns({
      message: delivery === undefined ? 'It is in Aman for you to see.' : spokenMessage(delivery),
      openChat: async () => {
        if (delivery === undefined) {
          return undefined;
        }
        const chat = await deps.chats.open({
          owner,
          delivery,
          call_id: call.id,
          opening: `Hi, it's ${greetingName}. ${CALL_LINES.message(spokenMessage(delivery))}`,
        });
        if (chat !== undefined) {
          await store.setSession({ id: call.id, session_id: chat.session_id });
        }
        return chat;
      },
      hangUp,
    });
    const session = new VoiceSession({
      ...parts,
      transport,
      turns,
      // Timings and reason codes only: what was said is never logged.
      onLatency: latency => {
        logger.info('phone call turn', latency);
      },
      onNote: note => {
        logger.info('phone call note', { note });
      },
    });
    session.start();
    void session.say(
      CALL_LINES.opening({
        name: greetingName,
        kind: delivery === undefined ? 'something needs you' : privatePhrase(delivery.kind),
      }),
    );
    const timeUp = setTimeout(() => {
      void session.say(CALL_LINES.timeUp).then(hangUp);
    }, MAX_TALK_MS);
    socket.once('close', () => {
      clearTimeout(timeUp);
      void (async () => {
        await session.end();
        turns.chat?.close();
        const outcome: PhoneCallOutcome = turns.answered ? 'answered' : 'not_now';
        if (!(await store.finish({ id: call.id, outcome, follow_ups: turns.followUps, now: now() }))) {
          return;
        }
        const waiting =
          turns.followUps === 0
            ? ''
            : ` ${String(turns.followUps)} ${turns.followUps === 1 ? 'thing is' : 'things are'} waiting for your ok in the chat.`;
        await deps.deliveries().recordAttempt({
          ...owner,
          delivery_id: call.delivery_id,
          attempt: attempt({
            outcome: 'sent',
            detail:
              outcome === 'answered'
                ? `You answered. The call lasted ${minutesWords(now().getTime() - startedAt.getTime())}, and what was said is in the chat.${waiting}`
                : 'You answered and said it was not a good time. It is waiting for you in the app.',
            target: null,
          }),
          ...(turns.chat === undefined ? {} : { conversation_id: turns.chat.session_id }),
        });
      })().catch((error: unknown) => {
        logger.warn('A phone call could not be written down', {
          call_id: call.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    return bytes => {
      session.pushAudio(bytes);
    };
  }

  function media(socket: WebSocket): void {
    let onAudio: ((bytes: Uint8Array) => void) | undefined;
    let transport: PhoneVoiceTransport | undefined;
    let started = false;
    const waitForStart = setTimeout(() => {
      socket.close(1008, 'no call');
    }, START_WAIT_MS);
    socket.on('close', () => {
      clearTimeout(waitForStart);
    });
    socket.on('message', data => {
      const frame = readPhoneFrame(data);
      if (frame.kind === 'audio') {
        onAudio?.(frame.bytes);
        return;
      }
      if (frame.kind === 'mark') {
        transport?.onMark(frame.name);
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
      clearTimeout(waitForStart);
      const token = frame.parameters['token'];
      void (async () => {
        const call =
          token === undefined
            ? undefined
            : await store.redeemToken({ call_sid: frame.callSid, token_hash: tokenHash(token), now: now() });
        if (call === undefined) {
          // Only the fact is logged: an unknown, used or expired token opens nothing.
          logger.warn('A media session was refused: it did not name a call Aman started');
          socket.close(1008, 'unknown call');
          return;
        }
        const line = new PhoneVoiceTransport({ socket, streamSid: frame.streamSid });
        transport = line;
        if (call.mode === 'voicemail') {
          await leaveVoicemail({ call, transport: line });
          return;
        }
        onAudio = await talk({ call, socket, transport: line });
      })().catch((error: unknown) => {
        logger.warn('A phone call could not start', { error: error instanceof Error ? error.message : String(error) });
        socket.close(1011, 'could not start');
      });
    });
  }

  return { sender, place, answered, statusChanged, media };
}
