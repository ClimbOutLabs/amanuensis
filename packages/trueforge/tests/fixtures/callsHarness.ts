import type { ServerType } from '@hono/node-server';
import winston from 'winston';
import WebSocket from 'ws';

import { DeliveryStore } from '../../src/db/deliveryStore';
import { migrateSqliteToLatest } from '../../src/db/migrateSqlite';
import { PhoneCallStore } from '../../src/db/phoneCallStore';
import { ReachSettingsStore } from '../../src/db/reachSettingsStore';
import { createSqliteDb } from '../../src/db/sqlite/client';
import { SqlitePersonalizationStore } from '../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { TextContactStore } from '../../src/db/textContactStore';
import type { CallChat } from '../../src/runtime/calls/callTurns';
import type { CallVoice } from '../../src/runtime/calls/callVoiceReady';
import {
  createPhoneCallService,
  type CallChats,
  type CallLimits,
  type CallListening,
} from '../../src/runtime/calls/phoneCalls';
import { MEDIA_STREAM_PATH, type CallProvider, type PlaceCallResult } from '../../src/runtime/calls/twilioCalls';
import type { DeliveryChannelSender } from '../../src/runtime/delivery/deliveryChannel';
import { createDeliveryService } from '../../src/runtime/delivery/deliveryService';
import type { SmsProvider } from '../../src/runtime/texts/smsProvider';
import { createSmsSender } from '../../src/runtime/texts/smsSender';
import { createTextNumberService } from '../../src/runtime/texts/textNumber';
import { defaultReachSettings } from '../../src/schemas/reach';
import { startTwilioWebhookListener } from '../../src/twilioWebhook/listener';
import { twilioSignature } from '../../src/twilioWebhook/signature';
import { phoneCallRoutes } from '../../src/twilioWebhook/voiceCall';
import { socketBytes, type SpeechSynthesizer } from '../../src/voice/transport';
import { confirmNumber } from './confirmedNumber';
import { closeServer, listeningPort } from './listenPort';
import { FakeStt, FakeTts, LoudnessVad } from './voice/fakes';

export const ALICE = { tenant_id: 'default', created_by: 'alice' };
export const PHONE = '+15550111';
export const ACCOUNT_SID = `AC${'a'.repeat(32)}`;
export const CALL_SID = `CA${'b'.repeat(32)}`;
export const PUBLIC_URL = 'https://aman.example.invalid';
export const AUTH_TOKEN = 'token-for-tests';

/**
 * Stores over one test database, a fake Twilio for texts and calls, a push channel that only records, and the call
 * service on a real Twilio listener. The clock only moves when a test moves it.
 */
export async function callsHarness({
  chat,
  assistantName = 'Mannie',
  limits,
  voice = 'ready',
  listening = () => Promise.resolve({ vad: new LoudnessVad(), stt: new FakeStt() }),
  tts = new FakeTts(),
  speaking,
  redeemGate,
  smsProvider: wireTexts,
  callProvider: wireCalls,
}: {
  chat?: CallChat;
  assistantName?: string;
  limits?: Partial<CallLimits>;
  /** A function lets a test switch the voice parts on part way through. */
  voice?: CallVoice | (() => CallVoice);
  /** What a conversation listens with; a test can make it slow or fail. */
  listening?: () => Promise<CallListening>;
  tts?: FakeTts;
  /** Another voice in place of the fake one, such as the real client against a fake service. */
  speaking?: (owner: { tenant_id: string; created_by: string }) => SpeechSynthesizer;
  /** Holds each media key's redeem until it settles, so a test can drop the line meanwhile. */
  redeemGate?: { reached: () => void; open: Promise<void> };
  /** Providers to send through instead of the recording ones, such as the real ones over a fake Twilio. */
  smsProvider?: SmsProvider;
  callProvider?: CallProvider;
} = {}) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const logger = winston.createLogger({ silent: true });
  const contacts = new TextContactStore(db);
  const reachSettings = new ReachSettingsStore(db);
  const deliveryStore = new DeliveryStore(db);
  const calls = new PhoneCallStore(db);
  if (redeemGate !== undefined) {
    const redeem = calls.redeemToken.bind(calls);
    calls.redeemToken = async input => {
      redeemGate.reached();
      await redeemGate.open;
      return redeem(input);
    };
  }
  const personalization = new SqlitePersonalizationStore(db);
  await personalization.upsertProfile({
    ...ALICE,
    updated_by: 'alice',
    assistant_name: assistantName,
    assistant_identity: null,
    voice_guidance: null,
    user_name: 'Dana Reyes',
    address_as: 'Dana',
    user_profile: null,
    pinned_preferences: [],
    help_areas: [],
    learned_profile: null,
    learning_enabled: false,
  });
  const clock = { now: new Date('2026-11-06T15:00:00.000Z') };
  const texts: { to: string; body: string }[] = [];
  const smsProvider: SmsProvider = wireTexts ?? {
    send: input => {
      texts.push(input);
      return Promise.resolve({ outcome: 'sent' });
    },
  };
  const pushes: string[] = [];
  const push: DeliveryChannelSender = {
    channel: 'web_push',
    send: ({ delivery }) => {
      if (delivery.level !== 'nudge') {
        return Promise.resolve([]);
      }
      pushes.push(delivery.id);
      return Promise.resolve([
        { channel: 'web_push', outcome: 'sent', detail: null, target: 'phone', attempted_at: clock.now.toISOString() },
      ]);
    },
  };
  const placed: { to: string; call_id: string }[] = [];
  const nextCall: { result: PlaceCallResult } = { result: { outcome: 'started', call_sid: CALL_SID } };
  const provider: CallProvider = wireCalls ?? {
    place: ({ to, call_id }) => {
      placed.push({ to, call_id });
      return Promise.resolve(nextCall.result);
    },
  };
  const opened: { opening: string; call_id: string; person: string | undefined }[] = [];
  const chats: CallChats = {
    open: ({ opening, call_id, names }) => {
      opened.push({ opening, call_id, person: names.person });
      return Promise.resolve(chat);
    },
  };
  const numbers = createTextNumberService({
    store: contacts,
    codeKey: 'test-code-key',
    reachSettings,
    personalization,
    provider: smsProvider,
    audit: { record: () => Promise.resolve() },
    logger,
    now: () => clock.now,
  });
  const activity: { tool_name: string; description: string; conversation_id: string | undefined }[] = [];
  const service = createPhoneCallService({
    store: calls,
    deliveryStore,
    contacts,
    reachSettings,
    personalization,
    twilio: { provider, accountSid: ACCOUNT_SID, publicUrl: PUBLIC_URL },
    voice: () => Promise.resolve(typeof voice === 'function' ? voice() : voice),
    deliveries: () => deliveries,
    chats,
    speaking: speaking ?? (() => tts),
    listening,
    logger,
    ...(limits === undefined ? {} : { limits }),
    now: () => clock.now,
  });
  const deliveries = createDeliveryService({
    store: deliveryStore,
    senders: [
      push,
      createSmsSender({
        contacts,
        reachSettings,
        personalization,
        provider: smsProvider,
        limits: { number_key: 'test-code-key', max_texts_per_day: 50 },
        textNumbers: numbers,
        now: () => clock.now,
      }),
      service.sender,
    ],
    audit: {
      record: input => {
        activity.push({
          tool_name: input.tool_name,
          description: input.description,
          conversation_id: input.conversation_id,
        });
        return Promise.resolve();
      },
    },
    logger,
    now: () => clock.now,
  });

  /** A person whose number is confirmed, with texts and calls switched on, the way the Settings page leaves them. */
  async function readyToCall({ texts: textsOn = true, pending }: { texts?: boolean; pending?: string } = {}) {
    await confirmNumber({
      store: contacts,
      owner: ALICE,
      phone: PHONE,
      now: new Date('2026-11-06T09:00:00.000Z'),
      ...(pending === undefined ? {} : { pending }),
    });
    const settings = defaultReachSettings('UTC');
    await reachSettings.put({ ...ALICE, settings: { ...settings, channels: { texts: textsOn, calls: true } } });
  }

  function callDelivery(text = 'Your 3pm clashes with the school pickup.') {
    return deliveries.deliver({
      ...ALICE,
      kind: 'nudge',
      level: 'call',
      text,
      reason: 'Two things on your calendar at the same time.',
      link: null,
    });
  }

  const { routes, sockets } = phoneCallRoutes({ calls: service });
  const server: ServerType = await startTwilioWebhookListener({
    settings: { authToken: AUTH_TOKEN, webhookPublicUrl: PUBLIC_URL, webhookPort: 0 },
    hostname: '127.0.0.1',
    routes,
    sockets,
    logger,
  });
  const port = await listeningPort(server);
  const base = `http://127.0.0.1:${String(port)}`;

  /** Posts a form to the listener the way Twilio does, signed with the account's token. */
  function twilioPost({ path, fields, sign = true }: { path: string; fields: Record<string, string>; sign?: boolean }) {
    const params = new URLSearchParams(fields);
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(sign
          ? { 'x-twilio-signature': twilioSignature({ authToken: AUTH_TOKEN, url: `${PUBLIC_URL}${path}`, params }) }
          : {}),
      },
      body: params.toString(),
    });
  }

  /** Opens the media stream the way Twilio does, echoing every mark back as played, and sends `start` unless told not to. */
  async function openMedia({
    token,
    callSid = CALL_SID,
    callId = placed.at(-1)?.call_id ?? '0'.repeat(26),
    sign = true,
    start = true,
  }: {
    token: string | undefined;
    callSid?: string;
    /** The call whose address the stream opens at; the last call placed unless told otherwise. */
    callId?: string;
    sign?: boolean;
    start?: boolean;
  }) {
    const path = `${MEDIA_STREAM_PATH}/${callId}`;
    const wssUrl = `${PUBLIC_URL.replace(/^https:/, 'wss:')}${path}`;
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${path}`, {
      headers: sign
        ? {
            'x-twilio-signature': twilioSignature({
              authToken: AUTH_TOKEN,
              url: wssUrl,
              params: new URLSearchParams(),
            }),
          }
        : {},
    });
    const frames: { event: string; media?: { payload: string }; mark?: { name: string } }[] = [];
    const closed = new Promise<number>(resolve => {
      socket.on('close', code => {
        resolve(code);
      });
    });
    const failed = new Promise<number | undefined>(resolve => {
      socket.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode);
      });
      socket.on('open', () => {
        resolve(undefined);
      });
      socket.on('error', () => {
        resolve(undefined);
      });
    });
    socket.on('message', data => {
      const frame: unknown = JSON.parse(socketBytes(data).toString('utf8'));
      if (typeof frame !== 'object' || frame === null || !('event' in frame) || typeof frame.event !== 'string') {
        return;
      }
      const name =
        'mark' in frame && typeof frame.mark === 'object' && frame.mark !== null && 'name' in frame.mark
          ? String(frame.mark.name)
          : undefined;
      frames.push({ event: frame.event, ...(name === undefined ? {} : { mark: { name } }) });
      if (frame.event === 'mark' && name !== undefined) {
        socket.send(JSON.stringify({ event: 'mark', streamSid: 'MZ1', mark: { name } }));
      }
    });
    const refusedWith = await failed;
    if (start && refusedWith === undefined && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
      socket.send(
        JSON.stringify({
          event: 'start',
          start: { streamSid: 'MZ1', callSid, customParameters: token === undefined ? {} : { token } },
        }),
      );
    }
    return { socket, frames, closed, refusedWith };
  }

  /** The one-time token the voice webhook put in its TwiML, or undefined when it hung up. */
  async function answer(answeredBy = 'human'): Promise<{ twiml: string; token: string | undefined }> {
    const response = await twilioPost({
      path: `/twilio/voice?call=${placed.at(-1)?.call_id ?? ''}`,
      fields: { AccountSid: ACCOUNT_SID, CallSid: CALL_SID, AnsweredBy: answeredBy, From: '+15550100', To: PHONE },
    });
    const twiml = await response.text();
    return { twiml, token: /<Parameter name="token" value="([^"]+)"/.exec(twiml)?.[1] };
  }

  /** Twilio's status webhook for the last call placed, or for another call id and Twilio id. */
  function status(
    callStatus: string,
    { callSid = CALL_SID, callId = placed.at(-1)?.call_id ?? '' }: { callSid?: string; callId?: string } = {},
  ) {
    return twilioPost({
      path: `/twilio/call-status?call=${callId}`,
      fields: { AccountSid: ACCOUNT_SID, CallSid: callSid, CallStatus: callStatus },
    });
  }

  /** Waits for a condition that is met by work the listener does after it answers. */
  async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
    const until = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > until) {
        throw new Error('timed out');
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  async function attemptsOf(id: string) {
    return (await deliveryStore.get({ ...ALICE, id }))?.attempts ?? [];
  }

  return {
    db,
    waitFor,
    attemptsOf,
    contacts,
    reachSettings,
    deliveryStore,
    calls,
    deliveries,
    service,
    texts,
    pushes,
    placed,
    nextCall,
    opened,
    tts,
    activity,
    clock,
    base,
    readyToCall,
    callDelivery,
    twilioPost,
    openMedia,
    answer,
    status,
    close: () => closeServer(server),
  };
}
