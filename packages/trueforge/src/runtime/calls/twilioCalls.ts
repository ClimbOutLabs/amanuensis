import { z } from 'zod';

import type { TwilioSettings } from '../../config';
import type { ResolveAddresses } from '../publicFetch';
import { publicTwilioFetch, twilioAuthorization, twilioErrorCode, type TwilioFetch } from '../texts/smsProvider';

/** Why a call could not be started. The words for the person are written by whoever shows it. */
export type CallFailure = 'invalid_number' | 'not_accepted' | 'unreachable';

export type PlaceCallResult = { outcome: 'started'; call_sid: string } | { outcome: 'failed'; failure: CallFailure };

/**
 * One way to ring the person's phone. A provider never throws: a failure comes back as a result, and what it says
 * never carries the number or any credential.
 */
export interface CallProvider {
  place(input: { to: string }): Promise<PlaceCallResult>;
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

const INVALID_NUMBER_CODES = new Set([13223, 13224, 21211, 21214, 21215, 21216, 21217, 21401]);

const CreatedCallSchema = z.object({ sid: z.string().regex(/^CA[0-9a-fA-F]{32}$/) });

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
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(settings.accountSid)}/Calls.json`;
  const authorization = twilioAuthorization(settings);
  return {
    async place({ to }) {
      const form = new URLSearchParams({
        To: to,
        From: settings.fromNumber,
        Url: `${settings.webhookPublicUrl}${VOICE_WEBHOOK_PATH}`,
        Method: 'POST',
        StatusCallback: `${settings.webhookPublicUrl}${CALL_STATUS_PATH}`,
        StatusCallbackMethod: 'POST',
        Timeout: String(RING_SECONDS),
        MachineDetection: 'DetectMessageEnd',
        MachineDetectionTimeout: String(MACHINE_DETECTION_SECONDS),
      });
      try {
        const reply = await fetchTwilio({
          url,
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new TextEncoder().encode(form.toString()),
        });
        const text = await reply.text();
        if (reply.status >= 200 && reply.status < 300) {
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = undefined;
          }
          const created = CreatedCallSchema.safeParse(body);
          return created.success
            ? { outcome: 'started', call_sid: created.data.sid }
            : { outcome: 'failed', failure: 'unreachable' };
        }
        const code = twilioErrorCode(text);
        if (code !== undefined && INVALID_NUMBER_CODES.has(code)) {
          return { outcome: 'failed', failure: 'invalid_number' };
        }
        return {
          outcome: 'failed',
          failure: reply.status === 401 || reply.status === 403 ? 'not_accepted' : 'unreachable',
        };
      } catch {
        return { outcome: 'failed', failure: 'unreachable' };
      }
    },
  };
}

/** The line shown to the person for a call that could not start, ending with the one thing to do. */
export function callFailureWords(failure: CallFailure): string {
  switch (failure) {
    case 'invalid_number':
      return 'The phone company would not call this number. Check it in Settings, Reach me.';
    case 'not_accepted':
      return 'Twilio did not accept the sign-in details. Check the account id and auth token in the settings file.';
    case 'unreachable':
      return 'The call could not be started. Try again in a minute.';
  }
}
