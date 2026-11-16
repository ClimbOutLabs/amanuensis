import { z } from 'zod';

import type { TwilioSettings } from '../../config';
import { CallSidSchema } from '../../schemas/phoneCalls';
import type { ResolveAddresses } from '../publicFetch';
import { PublicFetchError } from '../publicFetch';
import { postTwilioForm, publicTwilioFetch, twilioErrorCode, twilioRefusal, type TwilioFetch } from '../twilio/rest';

/** Why a call could not be started. The words for the person are written by whoever shows it. */
type CallFailure = 'invalid_number' | 'not_accepted' | 'unreachable';

/** `unknown` when no clear answer came back: Twilio may have started the call, so the phone may still ring. */
export type PlaceCallResult =
  { outcome: 'started'; call_sid: string } | { outcome: 'failed'; failure: CallFailure } | { outcome: 'unknown' };

/**
 * One way to ring the person's phone. A provider never throws: a failure comes back as a result, and what it says
 * never carries the number or any credential.
 */
export interface CallProvider {
  /** `call_id` is Aman's own id for the call, which Twilio sends back on every request about it. */
  place(input: { to: string; call_id: string }): Promise<PlaceCallResult>;
}

/** Where Twilio asks what to do once the call is answered. */
export const VOICE_WEBHOOK_PATH = '/twilio/voice';
/** Where Twilio says how the call ended, including when nobody answered. */
export const CALL_STATUS_PATH = '/twilio/call-status';
/** The media WebSocket, reached as wss through the same public address. */
export const MEDIA_STREAM_PATH = '/twilio/media';

/** How long the phone rings before Twilio gives up. */
const RING_SECONDS = 25;
/** How long Twilio may listen for a voicemail greeting to end before it connects the call anyway. */
const MACHINE_DETECTION_SECONDS = 30;
/** Twilio ends the call after this, whatever Aman is doing: a little longer than a call may talk. */
const TIME_LIMIT_SECONDS = 11 * 60;

const INVALID_NUMBER_CODES = new Set([13223, 13224, 21211, 21214, 21215, 21216, 21217, 21401]);

const CreatedCallSchema = z.object({ sid: CallSidSchema });

/**
 * Connection errors that mean the request never left this machine, so no call can have started. A certificate that
 * does not check out stops the connection before anything is sent.
 */
const NOT_SENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);

/**
 * Whether a failed request may still have reached Twilio. Only an address refused up front, or a connection that
 * could not be made, sent nothing; a timeout, a reset or anything unknown may have come after Twilio made the call.
 */
function requestMayHaveReached(error: unknown): boolean {
  if (error instanceof PublicFetchError) {
    return false;
  }
  const code =
    error instanceof Error && error.cause instanceof Error && 'code' in error.cause ? error.cause.code : undefined;
  if (
    typeof code === 'string' &&
    (NOT_SENT_CODES.has(code) || code.startsWith('CERT_') || code.startsWith('ERR_TLS'))
  ) {
    return false;
  }
  return true;
}

/**
 * Starts a call through Twilio's REST API. Twilio answers to the voice webhook with the call's own id, and asks the
 * phone company to tell a person from an answering machine, so a voicemail can be left after the greeting ends.
 */
export function createTwilioCallProvider({
  settings,
  resolveAddresses,
  fetchTwilio = publicTwilioFetch(resolveAddresses),
}: {
  settings: Pick<TwilioSettings, 'accountSid' | 'authToken' | 'fromNumber' | 'webhookPublicUrl'>;
  /** DNS seam for tests. */
  resolveAddresses?: ResolveAddresses;
  fetchTwilio?: TwilioFetch;
}): CallProvider {
  return {
    async place({ to, call_id }) {
      // The call's own id rides in the addresses Twilio calls back, which the signature covers.
      const about = `?call=${encodeURIComponent(call_id)}`;
      const form = new URLSearchParams({
        To: to,
        From: settings.fromNumber,
        Url: `${settings.webhookPublicUrl}${VOICE_WEBHOOK_PATH}${about}`,
        Method: 'POST',
        StatusCallback: `${settings.webhookPublicUrl}${CALL_STATUS_PATH}${about}`,
        StatusCallbackMethod: 'POST',
        Timeout: String(RING_SECONDS),
        TimeLimit: String(TIME_LIMIT_SECONDS),
        MachineDetection: 'DetectMessageEnd',
        MachineDetectionTimeout: String(MACHINE_DETECTION_SECONDS),
      });
      try {
        const reply = await postTwilioForm({ fetchTwilio, settings, resource: 'Calls.json', form });
        const text = await reply.text();
        if (reply.status >= 200 && reply.status < 300) {
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = undefined;
          }
          const created = CreatedCallSchema.safeParse(body);
          return created.success ? { outcome: 'started', call_sid: created.data.sid } : { outcome: 'unknown' };
        }
        const code = twilioErrorCode(text);
        if (code !== undefined && INVALID_NUMBER_CODES.has(code)) {
          return { outcome: 'failed', failure: 'invalid_number' };
        }
        // A server error may come after Twilio made the call, so it is not a sure failure.
        return reply.status >= 500
          ? { outcome: 'unknown' }
          : { outcome: 'failed', failure: twilioRefusal(reply.status) };
      } catch (error) {
        return requestMayHaveReached(error) ? { outcome: 'unknown' } : { outcome: 'failed', failure: 'unreachable' };
      }
    },
  };
}

/**
 * Why a call could not be started, and the one thing that happens or to do next. A real call already went out as a
 * text and a notice instead; a test sent nothing else.
 */
export function callFailureWords({ failure, test }: { failure: CallFailure; test: boolean }): string {
  switch (failure) {
    case 'invalid_number':
      return 'The phone company would not call this number. Check it in Settings, Reach me.';
    case 'not_accepted':
      return 'Twilio did not accept the sign-in details. Check the account id and auth token in the settings file.';
    case 'unreachable':
      return test
        ? 'The call could not be started. Try again in 2 minutes.'
        : 'The call could not be started. It was sent as a text and a notice instead.';
  }
}
