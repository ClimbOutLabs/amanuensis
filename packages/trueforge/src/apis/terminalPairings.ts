import { OpenAPIHono } from '@hono/zod-openapi';
import { extractErrorLogFields, type AuditLogWriter } from '@truefoundry/trueforge-core/core';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'winston';

import { resolveRequestContext } from '../auth/identity';
import { clientKeyFor, tooManyText } from '../auth/loginProxy';
import { LoginAttemptLimiter } from '../auth/loginRateLimit';
import configuration, { getPublicBaseUrl, getPublicUiBasePath } from '../config';
import type { ITerminalKeyStore } from '../db/terminalKeyStore';
import {
  completeTerminalPairingRoute,
  confirmTerminalPairingRoute,
  revokeCurrentTerminalKeyRoute,
  startTerminalPairingRoute,
} from '../routes/terminalPairingRoutes';
import { TerminalPairingService } from '../runtime/terminalPairing';

/** One answer for a code that is wrong, expired or already used, so the three cannot be told apart from outside. */
const PAIRING_CODE_REFUSED_MESSAGE =
  'That pairing code is not right, or it has expired. On the terminal, start pairing again and use the new code.';

/** One answer for a completion that names no live pairing. */
const PAIRING_GONE_MESSAGE = 'That pairing is not there any more. On the terminal, start pairing again.';

export interface TerminalPairingRouterDeps {
  terminalKeyStore: ITerminalKeyStore;
  audit: AuditLogWriter;
  logger: Logger;
  /** Gates the confirm and revoke-current routes; start and completion are public. */
  authMiddleware: MiddlewareHandler;
  /**
   * The instance owner's subject id when the sign-in mode can name it before anyone
   * signs in (local sign-in keeps the one user), else undefined. A pairing start is
   * recorded under the owner when this names one; when it cannot, the confirm records
   * the start instead, since the start itself is signed out.
   */
  resolveInstanceOwnerId?: () => Promise<string | undefined>;
  /** The pairing state; one per app. Tests pass their own to steer the clock. */
  pairingService?: TerminalPairingService;
  /** The limiter pairing starts and confirms share with the sign-in form's rules. Tests pass their own. */
  limiter?: LoginAttemptLimiter;
  /** How a caller is keyed for the limiter; tests pass their own. */
  clientKey?: (c: Context) => string;
}

/**
 * Terminal pairing surface (mounted at /api/v1/terminal-pairings). The terminal starts
 * a pairing and polls for its key; the signed-in person confirms the code in the web
 * app. Starts and confirms are rate limited the way the sign-in form is, and every
 * start, confirm and revoke writes an audit entry.
 */
export function createTerminalPairingRouter(deps: TerminalPairingRouterDeps) {
  const router = new OpenAPIHono();
  const service =
    deps.pairingService ?? new TerminalPairingService({ terminalKeyStore: deps.terminalKeyStore, logger: deps.logger });
  const limiter = deps.limiter ?? new LoginAttemptLimiter();
  const clientKey = deps.clientKey ?? clientKeyFor(configuration.TRUSTED_PROXY_ADDRESSES);

  const recordAudit = async (input: {
    tenant_id: string;
    created_by: string;
    tool_name: string;
    description: string;
  }): Promise<void> => {
    try {
      await deps.audit.record({
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        conversation_id: '',
        tier: 1,
        tool_name: input.tool_name,
        description: input.description,
        outcome: 'logged',
        auto_deny_reason: null,
      });
    } catch (auditError) {
      // The audit log being unavailable never changes a pairing.
      deps.logger.error('Failed to record a terminal pairing audit row', extractErrorLogFields(auditError));
    }
  };

  const recordStart = async (input: { tenant_id: string; created_by: string; device_name: string }): Promise<void> =>
    recordAudit({
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      tool_name: 'terminal_pairing.started',
      description: `A terminal pairing was started for a device named ${input.device_name}.`,
    });

  router.openapi(startTerminalPairingRoute, async c => {
    const pageStart = limiter.allowPageStart(clientKey(c));
    if (!pageStart.allowed) {
      // The sign-in form's refusal, in this surface's JSON shape: the same words, with the wait.
      return c.json({ error: { message: tooManyText(pageStart.retryAfterSeconds, 'address') } }, 429, {
        'Retry-After': String(pageStart.retryAfterSeconds),
      });
    }
    const body = c.req.valid('json');
    const started = await service.start({ device_name: body.device_name });
    const ownerId = deps.resolveInstanceOwnerId === undefined ? undefined : await deps.resolveInstanceOwnerId();
    if (ownerId !== undefined) {
      await recordStart({ tenant_id: 'default', created_by: ownerId, device_name: body.device_name });
      service.noteStartAuditRecorded(started.pairing_id, true);
    }
    const confirm_url = `${getPublicBaseUrl()}${getPublicUiBasePath()}pair-terminal?code=${encodeURIComponent(started.code)}`;
    return c.json(
      {
        data: {
          pairing_id: started.pairing_id,
          code: started.code,
          confirm_url,
          expires_at: started.expires_at,
        },
      },
      201,
    );
  });

  router.openapi(completeTerminalPairingRoute, async c => {
    const body = c.req.valid('json');
    const completion = await service.complete({ pairing_id: body.pairing_id, code: body.code });
    if (completion === undefined) {
      throw new HTTPException(404, { message: PAIRING_GONE_MESSAGE });
    }
    if (completion.status === 'waiting') {
      return c.json({ data: { status: 'waiting' as const } }, 200);
    }
    return c.json(
      {
        data: { status: 'paired' as const, terminal_key: completion.terminal_key, device_name: completion.device_name },
      },
      200,
    );
  });

  const gated = new OpenAPIHono();
  gated.use('*', deps.authMiddleware);

  gated.openapi(confirmTerminalPairingRoute, async c => {
    const requestContext = resolveRequestContext(c);
    const body = c.req.valid('json');
    // A code guess is an attempt like a password guess: the limiter sits in front of it.
    const permit = limiter.begin(clientKey(c), 'terminal-pairing');
    if (!permit.allowed) {
      throw new HTTPException(429, { message: tooManyText(permit.retryAfterSeconds, permit.scope) });
    }
    const confirmed = await service.confirm({
      code: body.code,
      owner: {
        tenant_id: requestContext.tenant_id,
        subject_id: requestContext.subject.id,
        subject_type: requestContext.subject.type,
        subject_display_name: requestContext.subject.display_name,
      },
    });
    if (confirmed === undefined) {
      permit.finish('failure');
      throw new HTTPException(404, { message: PAIRING_CODE_REFUSED_MESSAGE });
    }
    permit.finish('success');
    if (!confirmed.start_audit_recorded) {
      await recordStart({
        tenant_id: requestContext.tenant_id,
        created_by: requestContext.subject.id,
        device_name: confirmed.device_name,
      });
    }
    await recordAudit({
      tenant_id: requestContext.tenant_id,
      created_by: requestContext.subject.id,
      tool_name: 'terminal_pairing.confirmed',
      description: `You paired a terminal named ${confirmed.device_name}.`,
    });
    return c.json({ data: { device_name: confirmed.device_name, paired_at: confirmed.paired_at } }, 200);
  });

  gated.openapi(revokeCurrentTerminalKeyRoute, async c => {
    const requestContext = resolveRequestContext(c);
    if (requestContext.terminal_key_id === undefined) {
      throw new HTTPException(400, {
        message:
          'Only a paired terminal can revoke its own key this way. To revoke a terminal key, open Settings on the web.',
      });
    }
    const own = await deps.terminalKeyStore.listForOwner({
      tenant_id: requestContext.tenant_id,
      subject_id: requestContext.subject.id,
    });
    const record = own.find(key => key.id === requestContext.terminal_key_id);
    const revoked = await deps.terminalKeyStore.revoke({
      tenant_id: requestContext.tenant_id,
      subject_id: requestContext.subject.id,
      id: requestContext.terminal_key_id,
      revoked_at: new Date().toISOString(),
    });
    if (revoked) {
      await recordAudit({
        tenant_id: requestContext.tenant_id,
        created_by: requestContext.subject.id,
        tool_name: 'terminal_key.revoked',
        description:
          record === undefined
            ? 'A terminal revoked its own key.'
            : `The terminal named ${record.device_name} revoked its own key.`,
      });
    }
    return c.json({ data: { revoked: true as const } }, 200);
  });

  router.route('/', gated);
  return router;
}
