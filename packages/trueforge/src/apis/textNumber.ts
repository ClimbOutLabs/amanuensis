import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';

import type { ResolveRequestContext } from '../auth/identity';
import {
  confirmTextCodeRoute,
  deleteTextNumberRoute,
  getTextStatusRoute,
  sendTextCodeRoute,
  updateTextModeRoute,
} from '../routes/textRoutes';
import type { SmsFailure } from '../runtime/texts/smsProvider';
import { MAX_CODE_ATTEMPTS, type TextNumberService } from '../runtime/texts/textNumber';
import { TEXTS_NOT_SET_UP } from '../runtime/texts/textWords';

/** Why a code could not be sent, ending with the one thing to do. */
function codeFailureWords(failure: SmsFailure): string {
  switch (failure) {
    case 'opted_out':
      return 'This number replied STOP before. Reply START from that phone, then try again.';
    case 'invalid_number':
      return 'The phone company would not take this number. Check it, then try again.';
    case 'not_accepted':
      return 'Twilio did not accept this server’s sign-in details. Ask whoever runs Aman to check them.';
    case 'unreachable':
      return 'Twilio could not be reached. Try again in a few minutes.';
  }
}

interface TextNumberRouterDeps {
  textNumbers: TextNumberService;
  /** Whether this server has a text provider. Read per request. */
  available: () => boolean;
  resolveRequestContext: ResolveRequestContext;
}

/** The signed-in person's number for texts, mounted at /api/v1/user/reach/texts. */
export function createTextNumberRouter(deps: TextNumberRouterDeps) {
  const ownerOf = (c: Parameters<ResolveRequestContext>[0]) => {
    const context = deps.resolveRequestContext(c);
    return { tenant_id: context.tenant_id, created_by: context.subject.id };
  };

  const getHandler: RouteHandler<typeof getTextStatusRoute> = async c =>
    c.json({ data: await deps.textNumbers.status(ownerOf(c)) }, 200);

  const sendCodeHandler: RouteHandler<typeof sendTextCodeRoute> = async c => {
    const owner = ownerOf(c);
    if (!deps.available()) {
      return c.json({ error: { message: TEXTS_NOT_SET_UP } }, 409);
    }
    const { phone } = c.req.valid('json');
    const result = await deps.textNumbers.sendCode({ owner, phone });
    if (result.ok) {
      return c.json({ data: await deps.textNumbers.status(owner) }, 201);
    }
    switch (result.reason) {
      case 'bad_number':
        return c.json(
          { error: { message: 'That is not a phone number. Type it with the country code, such as +15550100.' } },
          400,
        );
      case 'rate_limited': {
        const minutes = result.retry_in_minutes === 1 ? '1 minute' : `${String(result.retry_in_minutes)} minutes`;
        return c.json({ error: { message: `Too many codes were sent. Wait ${minutes}, then ask for another.` } }, 429);
      }
      case 'not_set_up':
        return c.json({ error: { message: TEXTS_NOT_SET_UP } }, 409);
      case 'send_failed':
        return c.json({ error: { message: codeFailureWords(result.failure) } }, 502);
    }
  };

  const confirmHandler: RouteHandler<typeof confirmTextCodeRoute> = async c => {
    const owner = ownerOf(c);
    const { code } = c.req.valid('json');
    const result = await deps.textNumbers.confirm({ owner, code });
    if (result.ok) {
      return c.json({ data: await deps.textNumbers.status(owner) }, 200);
    }
    switch (result.reason) {
      case 'no_code':
        return c.json({ error: { message: 'There is no code waiting. Ask for a new code.' } }, 400);
      case 'expired':
        return c.json({ error: { message: 'That code ran out. Ask for a new code.' } }, 400);
      case 'too_many':
        return c.json(
          {
            error: {
              message: `That was ${String(MAX_CODE_ATTEMPTS)} wrong tries, so the code is void. Ask for a new code.`,
            },
          },
          400,
        );
      case 'wrong':
        return c.json(
          { error: { message: `That code is not right. You have ${String(result.attempts_left)} tries left.` } },
          400,
        );
    }
  };

  const updateHandler: RouteHandler<typeof updateTextModeRoute> = async c => {
    const owner = ownerOf(c);
    const { mode } = c.req.valid('json');
    const result = await deps.textNumbers.setMode({ owner, mode });
    if (!result.ok) {
      return c.json({ error: { message: 'Add your number first.' } }, 409);
    }
    return c.json({ data: await deps.textNumbers.status(owner) }, 200);
  };

  const deleteHandler: RouteHandler<typeof deleteTextNumberRoute> = async c => {
    await deps.textNumbers.remove(ownerOf(c));
    return c.json({}, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(getTextStatusRoute, getHandler);
  router.openapi(sendTextCodeRoute, sendCodeHandler);
  router.openapi(confirmTextCodeRoute, confirmHandler);
  router.openapi(updateTextModeRoute, updateHandler);
  router.openapi(deleteTextNumberRoute, deleteHandler);
  return router;
}
