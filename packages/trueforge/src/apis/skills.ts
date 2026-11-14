import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ResolveRequestContext } from '../auth/identity';
import { SkillNameConflictError, type ISkillStore, type SkillRecord } from '../db/skillStore';
import type { WithTransaction } from '../db/transaction';
import {
  createSkillRoute,
  deleteSkillNetworkAllowedHostRoute,
  deleteSkillNetworkApprovalRoute,
  deleteSkillNetworkDeniedHostRoute,
  deleteSkillRoute,
  getSkillNetworkApprovalRoute,
  listAvailableSkillsRoute,
  listConfiguredSkillsRoute,
  listSkillVersionsRoute,
  putSkillRoute,
  updateSkillNetworkAllowedHostRoute,
  updateSkillNetworkApprovalRoute,
  updateSkillNetworkDeniedHostRoute,
} from '../routes/skillRoutes';
import { skillNetworkTokens } from '../sandbox/skillnet/skillNetworkTokens';
import type {
  AvailableSkill,
  ConfiguredSkill,
  CreateSkillRequest,
  SkillNetworkApproval,
  UpdateSkillNetworkApprovalRequest,
  UpdateSkillNetworkHostRequest,
  UpdateSkillRequest,
} from '../schemas/skill';
import {
  effectiveSkillNetworkHosts,
  parseGitSkill,
  parseTrueFoundryRegistrySkill,
  skillNetworkHostsCanSend,
} from '../schemas/skill';

export type ResolveSkillStore<TTransaction = never> = (c: Context) => ISkillStore<TTransaction>;

export interface SkillsRouterDeps<TTransaction> {
  resolveSkillStore: ResolveSkillStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
}

function toConfiguredSkill(record: SkillRecord): ConfiguredSkill {
  return {
    name: record.name,
    manifest: record.manifest,
  };
}

/** The approval state Settings shows: what the skill declares, what is in force, whether sending is in play. */
function toSkillNetworkApproval(
  record: SkillRecord,
  viewer?: { tenant_id: string; created_by: string },
): SkillNetworkApproval {
  const declared = parseGitSkill(record.manifest)?.network_hosts ?? [];
  const effective = effectiveSkillNetworkHosts({
    declared,
    approved: record.network_approval,
    denied: record.network_denied_hosts,
  });
  const denied = new Set(record.network_denied_hosts);
  return {
    declared_hosts: [...declared],
    approved_hosts: effective === null ? null : [...effective],
    allowed_hosts: record.network_allowed_hosts.filter(host => !denied.has(host)),
    denied_hosts: [...record.network_denied_hosts],
    session_hosts:
      viewer === undefined
        ? []
        : [
            ...skillNetworkTokens.sessionHostsForSkill({
              tenant_id: viewer.tenant_id,
              created_by: viewer.created_by,
              skill_name: record.name,
            }),
          ],
    send_capable: skillNetworkHostsCanSend(declared),
  };
}

async function findSkillRecord<TTransaction>(
  deps: SkillsRouterDeps<TTransaction>,
  c: Context,
  name: string,
): Promise<SkillRecord | undefined> {
  const requestContext = deps.resolveRequestContext(c);
  const records = await deps.resolveSkillStore(c).listSkills({
    tenant_id: requestContext.tenant_id,
    names: [name],
  });
  return records[0];
}

function toAvailableSkill(record: SkillRecord): AvailableSkill {
  const { manifest } = record;
  const registry = parseTrueFoundryRegistrySkill(manifest);
  if (registry !== undefined) {
    return {
      name: record.name,
      description: registry.description,
      metadata: {
        display_name: registry.display_name,
        repository_name: registry.repository_name,
        version: String(registry.version),
      },
    };
  }
  return { name: record.name, description: manifest.description };
}

/** Admin/settings skills CRUD (mounted at /api/v1/settings/skills). */
export function createSkillsRouter<TTransaction>(deps: SkillsRouterDeps<TTransaction>) {
  const listConfiguredHandler: RouteHandler<typeof listConfiguredSkillsRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const records = await deps.resolveSkillStore(c).listSkills({
      tenant_id: requestContext.tenant_id,
      names: undefined,
    });
    return c.json({ data: records.map(toConfiguredSkill) }, 200);
  };

  const createHandler: RouteHandler<typeof createSkillRoute> = async c => {
    const body: CreateSkillRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const { manifest } = body;
    try {
      const record = await deps.resolveSkillStore(c).createSkill({
        tenant_id: requestContext.tenant_id,
        name: manifest.name,
        manifest,
      });
      return c.json({ data: toConfiguredSkill(record) }, 201);
    } catch (error) {
      if (error instanceof SkillNameConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const putHandler: RouteHandler<typeof putSkillRoute> = async c => {
    const body: UpdateSkillRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const { manifest } = body;
    const record = await deps.resolveSkillStore(c).upsertSkill({
      tenant_id: requestContext.tenant_id,
      name: manifest.name,
      manifest,
    });
    return c.json({ data: toConfiguredSkill(record) }, 200);
  };

  const deleteHandler: RouteHandler<typeof deleteSkillRoute> = async c => {
    const { name } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const deleted = await deps.resolveSkillStore(c).deleteSkill({ tenant_id: requestContext.tenant_id, name });
    if (!deleted) {
      return c.json({ error: { message: `No skill with this name: ${name}` } }, 404);
    }
    return c.json({}, 200);
  };

  const getNetworkApprovalHandler: RouteHandler<typeof getSkillNetworkApprovalRoute> = async c => {
    const { name } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await findSkillRecord(deps, c, name);
    if (record === undefined) {
      return c.json({ error: { message: `No skill with this name: ${name}` } }, 404);
    }
    return c.json(
      {
        data: toSkillNetworkApproval(record, {
          tenant_id: requestContext.tenant_id,
          created_by: requestContext.subject.id,
        }),
      },
      200,
    );
  };

  const updateNetworkApprovalHandler: RouteHandler<typeof updateSkillNetworkApprovalRoute> = async c => {
    const { name } = c.req.valid('param');
    const body: UpdateSkillNetworkApprovalRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const record = await findSkillRecord(deps, c, name);
    if (record === undefined) {
      return c.json({ error: { message: `No skill with this name: ${name}` } }, 404);
    }
    const declared = parseGitSkill(record.manifest)?.network_hosts ?? [];
    const sent = new Set(body.hosts);
    const matchesDeclaration = sent.size === declared.length && declared.every(host => sent.has(host));
    if (!matchesDeclaration) {
      return c.json(
        {
          error: {
            message:
              'The list of sites changed since this page was loaded. Close this, open the skill again, and allow the list you see there.',
          },
        },
        422,
      );
    }
    const updated = await deps.resolveSkillStore(c).setSkillNetworkApproval({
      tenant_id: requestContext.tenant_id,
      name,
      hosts: [...declared],
    });
    if (updated === undefined) {
      return c.json({ error: { message: `No skill with this name: ${name}` } }, 404);
    }
    return c.json(
      {
        data: toSkillNetworkApproval(updated, {
          tenant_id: requestContext.tenant_id,
          created_by: requestContext.subject.id,
        }),
      },
      200,
    );
  };

  const setHostDecision = async (
    c: Context,
    name: string,
    host: string,
    decision: 'allowed' | 'denied' | 'none',
  ): Promise<SkillRecord | undefined> => {
    const requestContext = deps.resolveRequestContext(c);
    return deps.resolveSkillStore(c).setSkillNetworkHostDecision({
      tenant_id: requestContext.tenant_id,
      name,
      host,
      decision,
    });
  };

  const updateAllowedHostHandler: RouteHandler<typeof updateSkillNetworkAllowedHostRoute> = async c => {
    const { name } = c.req.valid('param');
    const body: UpdateSkillNetworkHostRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const updated = await setHostDecision(c, name, body.host, 'allowed');
    if (updated === undefined) {
      return c.json({ error: { message: `No skill with this name: ${name}` } }, 404);
    }
    return c.json(
      {
        data: toSkillNetworkApproval(updated, {
          tenant_id: requestContext.tenant_id,
          created_by: requestContext.subject.id,
        }),
      },
      200,
    );
  };

  const deleteAllowedHostHandler: RouteHandler<typeof deleteSkillNetworkAllowedHostRoute> = async c => {
    const { name } = c.req.valid('param');
    const { host } = c.req.valid('query');
    const record = await findSkillRecord(deps, c, name);
    if (record === undefined) {
      return c.json({ error: { message: `No skill with this name: ${name}` } }, 404);
    }
    // The store holds one decision per site, so clearing the site removes it from both the
    // allowed and the turned-down lists.
    if (record.network_allowed_hosts.includes(host)) {
      await setHostDecision(c, name, host, 'none');
    }
    return c.json({}, 200);
  };

  const updateDeniedHostHandler: RouteHandler<typeof updateSkillNetworkDeniedHostRoute> = async c => {
    const { name } = c.req.valid('param');
    const body: UpdateSkillNetworkHostRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const updated = await setHostDecision(c, name, body.host, 'denied');
    if (updated === undefined) {
      return c.json({ error: { message: `No skill with this name: ${name}` } }, 404);
    }
    return c.json(
      {
        data: toSkillNetworkApproval(updated, {
          tenant_id: requestContext.tenant_id,
          created_by: requestContext.subject.id,
        }),
      },
      200,
    );
  };

  const deleteDeniedHostHandler: RouteHandler<typeof deleteSkillNetworkDeniedHostRoute> = async c => {
    const { name } = c.req.valid('param');
    const { host } = c.req.valid('query');
    const record = await findSkillRecord(deps, c, name);
    if (record === undefined) {
      return c.json({ error: { message: `No skill with this name: ${name}` } }, 404);
    }
    if (record.network_denied_hosts.includes(host)) {
      await setHostDecision(c, name, host, 'none');
    }
    return c.json({}, 200);
  };

  const deleteNetworkApprovalHandler: RouteHandler<typeof deleteSkillNetworkApprovalRoute> = async c => {
    const { name } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const updated = await deps.resolveSkillStore(c).setSkillNetworkApproval({
      tenant_id: requestContext.tenant_id,
      name,
      hosts: null,
    });
    if (updated === undefined) {
      return c.json({ error: { message: `No skill with this name: ${name}` } }, 404);
    }
    return c.json({}, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listConfiguredSkillsRoute, listConfiguredHandler);
  router.openapi(createSkillRoute, createHandler);
  router.openapi(putSkillRoute, putHandler);
  router.openapi(deleteSkillRoute, deleteHandler);
  router.openapi(getSkillNetworkApprovalRoute, getNetworkApprovalHandler);
  router.openapi(updateSkillNetworkApprovalRoute, updateNetworkApprovalHandler);
  router.openapi(deleteSkillNetworkApprovalRoute, deleteNetworkApprovalHandler);
  router.openapi(updateSkillNetworkAllowedHostRoute, updateAllowedHostHandler);
  router.openapi(deleteSkillNetworkAllowedHostRoute, deleteAllowedHostHandler);
  router.openapi(updateSkillNetworkDeniedHostRoute, updateDeniedHostHandler);
  router.openapi(deleteSkillNetworkDeniedHostRoute, deleteDeniedHostHandler);
  return router;
}

/** Chat slim list (mounted at /api/v1/skills). */
export function createAvailableSkillsRouter<TTransaction>(deps: SkillsRouterDeps<TTransaction>) {
  const router = new OpenAPIHono();
  router.openapi(listAvailableSkillsRoute, async c => {
    const requestContext = deps.resolveRequestContext(c);
    const records = await deps.resolveSkillStore(c).listSkills({
      tenant_id: requestContext.tenant_id,
      names: undefined,
    });
    return c.json({ data: records.map(toAvailableSkill) }, 200);
  });

  router.openapi(listSkillVersionsRoute, async c => {
    const { name } = c.req.valid('query');
    const skillVersions = await deps.resolveSkillStore(c).listSkillVersions({ name });
    return c.json({ data: skillVersions }, 200);
  });

  return router;
}
