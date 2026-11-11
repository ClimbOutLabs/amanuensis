import type { PhoneCallService } from '../runtime/calls/phoneCalls';
import { CALL_STATUS_PATH, MEDIA_STREAM_PATH, VOICE_WEBHOOK_PATH } from '../runtime/calls/twilioCalls';
import { ID_SHAPE } from '../utils/id';
import { EMPTY_TWIML, type TwilioSocketRoute, type TwilioWebhookRoute } from './listener';

/**
 * The phone call's addresses on the Twilio listener: the voice webhook Twilio asks once the call is answered, the
 * status webhook it tells how the call ended, and the media stream the conversation runs over. Each is signed by
 * Twilio; each call's media stream has its own address, so its signature opens no other call. The stream must also
 * carry the one-time token the voice webhook gave out for that same call.
 */
export function phoneCallRoutes({
  calls,
}: {
  calls: Pick<PhoneCallService, 'answered' | 'statusChanged' | 'media' | 'mayStream'>;
}): {
  routes: TwilioWebhookRoute[];
  sockets: TwilioSocketRoute[];
} {
  return {
    routes: [
      {
        method: 'POST',
        path: VOICE_WEBHOOK_PATH,
        async handle(request) {
          return { status: 200, body: await calls.answered(request) };
        },
      },
      {
        method: 'POST',
        path: CALL_STATUS_PATH,
        async handle(request) {
          await calls.statusChanged(request);
          return { status: 200, body: EMPTY_TWIML };
        },
      },
    ],
    sockets: [
      {
        path: MEDIA_STREAM_PATH,
        idShape: ID_SHAPE,
        admits: id => calls.mayStream(id),
        open: (socket, id) => {
          calls.media({ socket, call_id: id });
        },
      },
    ],
  };
}
