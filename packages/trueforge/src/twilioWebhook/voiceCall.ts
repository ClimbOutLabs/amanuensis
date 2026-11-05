import type { PhoneCallService } from '../runtime/calls/phoneCalls';
import { CALL_STATUS_PATH, MEDIA_STREAM_PATH, VOICE_WEBHOOK_PATH } from '../runtime/calls/twilioCalls';
import { EMPTY_TWIML, type TwilioSocketRoute, type TwilioWebhookRoute } from './listener';

/**
 * The phone call's addresses on the Twilio listener: the voice webhook Twilio asks once the call is answered, the
 * status webhook it tells how the call ended, and the media stream the conversation runs over. Each is signed by
 * Twilio; the media stream must also carry the one-time token the voice webhook gave out for that same call.
 */
export function phoneCallRoutes({ calls }: { calls: Pick<PhoneCallService, 'answered' | 'statusChanged' | 'media'> }): {
  routes: TwilioWebhookRoute[];
  sockets: TwilioSocketRoute[];
} {
  return {
    routes: [
      {
        method: 'POST',
        path: VOICE_WEBHOOK_PATH,
        async handle({ params }) {
          return { status: 200, body: await calls.answered(params) };
        },
      },
      {
        method: 'POST',
        path: CALL_STATUS_PATH,
        async handle({ params }) {
          await calls.statusChanged(params);
          return { status: 200, body: EMPTY_TWIML };
        },
      },
    ],
    sockets: [
      {
        path: MEDIA_STREAM_PATH,
        open: socket => {
          calls.media(socket);
        },
      },
    ],
  };
}
