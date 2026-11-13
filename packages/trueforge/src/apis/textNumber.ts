import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';

import type { ResolveRequestContext } from '../auth/identity';
import {
  addTextWordRoute,
  confirmTextCodeRoute,
  deleteTextNumberRoute,
  getTextStatusRoute,
  removeTextWordRoute,
  sendTextCodeRoute,
  updateTextModeRoute,
} from '../routes/textRoutes';
import { smsFailureWords } from '../runtime/texts/smsProvider';
import { waitWords } from '../runtime/texts/textLimits';
import { MAX_CODE_ATTEMPTS, type TextNumberService } from '../runtime/texts/textNumber';
import { TEXTS_NOT_SET_UP } from '../runtime/texts/textWords';

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
      case 'rate_limited':
        return c.json(
          {
            error: {
              message: `Too many codes were sent. Wait ${waitWords(result.retry_in_minutes)}, then ask for another.`,
            },
          },
          429,
        );
      case 'not_set_up':
        return c.json({ error: { message: TEXTS_NOT_SET_UP } }, 409);
      case 'send_failed':
        return c.json({ error: { message: smsFailureWords({ failure: result.failure, during: 'code' }) } }, 502);
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

  const addWordHandler: RouteHandler<typeof addTextWordRoute> = async c => {
    const owner = ownerOf(c);
    const result = await deps.textNumbers.addWord({ owner, word: c.req.valid('json').word });
    if (result.ok) {
      return c.json({ data: await deps.textNumbers.status(owner) }, 201);
    }
    if (result.reason === 'full') {
      return c.json({ error: { message: 'That is as many words as can be added. Remove one to add another.' } }, 409);
    }
    return c.json({ error: { message: result.problem } }, 400);
  };

  const removeWordHandler: RouteHandler<typeof removeTextWordRoute> = async c => {
    const owner = ownerOf(c);
    await deps.textNumbers.removeWord({ owner, word: c.req.valid('param').word });
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
  router.openapi(addTextWordRoute, addWordHandler);
  router.openapi(removeTextWordRoute, removeWordHandler);
  router.openapi(deleteTextNumberRoute, deleteHandler);
  return router;
}
