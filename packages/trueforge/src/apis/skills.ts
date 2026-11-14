import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ResolveRequestContext } from '../auth/identity';
import { SkillNameConflictError, type ISkillStore, type SkillRecord } from '../db/skillStore';
import type { WithTransaction } from '../db/transaction';
import {
  checkSkillWebsitesRoute,
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
import { sameWebsites, settleSkillWebsites, skillSourceKey, type ReadSkillFiles } from '../runtime/skillWebsites';
import { skillNetworkTokens } from '../sandbox/skillnet/skillNetworkTokens';
import type {
  AvailableSkill,
  CheckSkillWebsitesRequest,
  ConfiguredSkill,
  CreateSkillRequest,
  GitSkill,
  SkillManifest,
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
import type { CatalogSkill } from '../schemas/skillCatalog';

export type ResolveSkillStore<TTransaction = never> = (c: Context) => ISkillStore<TTransaction>;

export interface SkillsRouterDeps<TTransaction> {
  resolveSkillStore: ResolveSkillStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
}

export interface SettingsSkillsRouterDeps<TTransaction> extends SkillsRouterDeps<TTransaction> {
  /** The starter skills; one of these at its pinned version is taken as shipped, never read. */
  catalog: readonly CatalogSkill[];
  /** Reads every file of a git skill so its websites can be found. */
  readFiles: ReadSkillFiles;
}

const UNREADABLE_SKILL =
  "Aman could not read this skill's files to check which websites it uses. Check the address, folder and branch, then try again.";
const TOO_MANY_WEBSITES = 'This skill sends requests to more websites than one skill may use, so it cannot be added.';
const WEBSITES_CHANGED =
  'The websites this skill sends requests to are not the ones you approved. Check the skill again and approve the list it shows.';

type SettledManifest =
  { ok: true; manifest: SkillManifest; hosts: readonly string[] } | { ok: false; status: 422; message: string };

/**
 * A git skill is stored at the commit Aman read, with the websites found in its files, never a
 * list sent with it, so what is approved is what Aman itself read. Other skill kinds are stored as
 * sent.
 */
async function settleManifest<TTransaction>(input: {
  deps: SettingsSkillsRouterDeps<TTransaction>;
  manifest: SkillManifest;
  /** The saved version of this skill, if any: an edit that keeps its source is not read again. */
  saved?: SkillManifest | undefined;
}): Promise<SettledManifest> {
  const git = parseGitSkill(input.manifest);
  if (git === undefined) {
    return { ok: true, manifest: input.manifest, hosts: [] };
  }
  const saved = input.saved === undefined ? undefined : parseGitSkill(input.saved);
  if (saved !== undefined && skillSourceKey(saved) === skillSourceKey(git) && saved.ref === git.ref) {
    const kept: GitSkill = { ...git };
    delete kept.network_hosts;
    if (saved.network_hosts !== undefined && saved.network_hosts.length > 0) {
      kept.network_hosts = saved.network_hosts;
    }
    return { ok: true, manifest: kept, hosts: saved.network_hosts ?? [] };
  }
  const found = await settleSkillWebsites({
    readFiles: input.deps.readFiles,
    catalog: input.deps.catalog,
    source: { url: git.url, path: git.path ?? '', ref: git.ref },
  });
  if (!found.ok) {
    return { ok: false, status: 422, message: found.problem === 'too_many' ? TOO_MANY_WEBSITES : UNREADABLE_SKILL };
  }
  // The stored list is always the scan's; whatever the request named is dropped.
  const manifest: GitSkill = { ...git, ref: found.value.commit };
  delete manifest.network_hosts;
  if (found.value.hosts.length > 0) {
    manifest.network_hosts = found.value.hosts;
  }
  return { ok: true, manifest, hosts: found.value.hosts };
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
export function createSkillsRouter<TTransaction>(deps: SettingsSkillsRouterDeps<TTransaction>) {
  const listConfiguredHandler: RouteHandler<typeof listConfiguredSkillsRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const records = await deps.resolveSkillStore(c).listSkills({
      tenant_id: requestContext.tenant_id,
      names: undefined,
    });
    return c.json({ data: records.map(toConfiguredSkill) }, 200);
  };

  const checkWebsitesHandler: RouteHandler<typeof checkSkillWebsitesRoute> = async c => {
    const body: CheckSkillWebsitesRequest = c.req.valid('json');
    const found = await settleSkillWebsites({
      readFiles: deps.readFiles,
      catalog: deps.catalog,
      source: { url: body.url, path: body.path ?? '', ref: body.ref },
    });
    if (!found.ok) {
      return c.json({ error: { message: found.problem === 'too_many' ? TOO_MANY_WEBSITES : UNREADABLE_SKILL } }, 422);
    }
    const { commit, hosts, makesUpAddresses, canSend } = found.value;
    return c.json({ data: { commit, websites: hosts, makes_up_addresses: makesUpAddresses, can_send: canSend } }, 200);
  };

  // Adding is all or nothing: the skill and the approval of its websites are saved together, and
  // only when the person approved exactly the websites Aman found.
  const createHandler: RouteHandler<typeof createSkillRoute> = async c => {
    const body: CreateSkillRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const settled = await settleManifest({ deps, manifest: body.manifest });
    if (!settled.ok) {
      return c.json({ error: { message: settled.message } }, settled.status);
    }
    const { manifest, hosts } = settled;
    if (!sameWebsites({ found: hosts, approved: body.approved_websites ?? [] })) {
      return c.json({ error: { message: WEBSITES_CHANGED } }, 409);
    }
    const store = deps.resolveSkillStore(c);
    const input = { tenant_id: requestContext.tenant_id, name: manifest.name, manifest };
    try {
      // A skill with no websites is saved alone, exactly as before.
      const record =
        hosts.length === 0
          ? await store.createSkill(input)
          : await deps.withTransaction(async transaction => {
              await store.createSkill(input, transaction);
              const approved = await store.setSkillNetworkApproval(
                { tenant_id: requestContext.tenant_id, name: manifest.name, hosts },
                transaction,
              );
              if (approved === undefined) {
                throw new HTTPException(500, { message: 'The skill could not be saved. Try again.' });
              }
              return approved;
            });
      return c.json({ data: toConfiguredSkill(record) }, 201);
    } catch (error) {
      if (error instanceof SkillNameConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  // Replacing a skill re-reads its websites. The approval changes only when the person approved
  // the new list; otherwise a grown list is no longer covered and grants nothing new.
  const putHandler: RouteHandler<typeof putSkillRoute> = async c => {
    const body: UpdateSkillRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const saved =
      parseGitSkill(body.manifest) === undefined ? undefined : await findSkillRecord(deps, c, body.manifest.name);
    const settled = await settleManifest({ deps, manifest: body.manifest, saved: saved?.manifest });
    if (!settled.ok) {
      return c.json({ error: { message: settled.message } }, settled.status);
    }
    const { manifest, hosts } = settled;
    const store = deps.resolveSkillStore(c);
    const approved = body.approved_websites;
    const approves = approved !== undefined && sameWebsites({ found: hosts, approved });
    if (approved !== undefined && !approves) {
      return c.json({ error: { message: WEBSITES_CHANGED } }, 409);
    }
    // A new skill with websites is added only together with their approval.
    if (!approves && hosts.length > 0 && saved === undefined) {
      return c.json({ error: { message: WEBSITES_CHANGED } }, 409);
    }
    const input = { tenant_id: requestContext.tenant_id, name: manifest.name, manifest };
    if (!approves || hosts.length === 0) {
      const saved = await store.upsertSkill(input);
      return c.json({ data: toConfiguredSkill(saved) }, 200);
    }
    const record = await deps.withTransaction(async transaction => {
      await store.upsertSkill(input, transaction);
      const withApproval = await store.setSkillNetworkApproval(
        { tenant_id: requestContext.tenant_id, name: manifest.name, hosts },
        transaction,
      );
      if (withApproval === undefined) {
        throw new HTTPException(500, { message: 'The skill could not be saved. Try again.' });
      }
      return withApproval;
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
    // The skill's own websites went with its record; its allow-once answers in open chats go too.
    skillNetworkTokens.forgetSkill({ tenant_id: requestContext.tenant_id, skill_name: name });
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
  router.openapi(checkSkillWebsitesRoute, checkWebsitesHandler);
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
