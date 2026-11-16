import { OpenAPIHono } from '@hono/zod-openapi';
import { extractErrorLogFields, type AuditLogWriter } from '@truefoundry/trueforge-core/core';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'winston';

import type { ResolveRequestContext } from '../auth/identity';
import type { ITerminalKeyStore, TerminalKeyRecord } from '../db/terminalKeyStore';
import { deleteTerminalKeyRoute, listTerminalKeysRoute } from '../routes/terminalPairingRoutes';
import type { TerminalKey } from '../schemas/terminalPairing';

export interface TerminalKeysRouterDeps {
  terminalKeyStore: ITerminalKeyStore;
  audit: AuditLogWriter;
  logger: Logger;
  resolveRequestContext: ResolveRequestContext;
}

/** A stored key as the Settings list shows it: never the key, never its hash. */
function toWireKey(record: TerminalKeyRecord): TerminalKey {
  return {
    id: record.id,
    device_name: record.device_name,
    paired_at: record.created_at,
    last_used_at: record.last_used_at,
    revoked_at: record.revoked_at,
  };
}

/**
 * The paired terminals surface for Settings (mounted at /api/v1/settings/terminal-keys,
 * behind the settings mount's admin gate). Listing shows names and times only, and
 * deleting a row revokes that key, which stops working on its next request.
 */
export function createTerminalKeysRouter(deps: TerminalKeysRouterDeps) {
  const router = new OpenAPIHono();

  router.openapi(listTerminalKeysRoute, async c => {
    const requestContext = deps.resolveRequestContext(c);
    const records = await deps.terminalKeyStore.listForOwner({
      tenant_id: requestContext.tenant_id,
      subject_id: requestContext.subject.id,
    });
    return c.json({ data: records.map(toWireKey) }, 200);
  });

  router.openapi(deleteTerminalKeyRoute, async c => {
    const requestContext = deps.resolveRequestContext(c);
    const owner = { tenant_id: requestContext.tenant_id, subject_id: requestContext.subject.id };
    const { terminal_key_id } = c.req.valid('param');
    const records = await deps.terminalKeyStore.listForOwner(owner);
    const record = records.find(key => key.id === terminal_key_id);
    if (record === undefined) {
      throw new HTTPException(404, { message: 'That terminal key is not there.' });
    }
    const revoked = await deps.terminalKeyStore.revoke({
      ...owner,
      id: terminal_key_id,
      revoked_at: new Date().toISOString(),
    });
    if (revoked) {
      try {
        await deps.audit.record({
          tenant_id: owner.tenant_id,
          created_by: owner.subject_id,
          conversation_id: '',
          tier: 1,
          tool_name: 'terminal_key.revoked',
          description: `You revoked the terminal key for ${record.device_name}.`,
          outcome: 'logged',
          auto_deny_reason: null,
        });
      } catch (auditError) {
        // The audit log being unavailable never changes a revoke.
        deps.logger.error('Failed to record a terminal key audit row', extractErrorLogFields(auditError));
      }
    }
    return c.json({}, 200);
  });

  return router;
}
