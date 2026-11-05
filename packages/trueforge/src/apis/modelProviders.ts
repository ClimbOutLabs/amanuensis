import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ResolveRequestContext } from '../auth/identity';
import {
  ModelProviderNameConflictError,
  type IModelProviderStore,
  type ModelProviderRecord,
} from '../db/modelProviderStore';
import type { WithTransaction } from '../db/transaction';
import {
  createModelProviderRoute,
  deleteModelProviderRoute,
  listModelProvidersRoute,
  putModelProviderRoute,
} from '../routes/modelProviderRoutes';
import {
  modelProviderName,
  type ConfiguredModelProvider,
  type CreateModelProviderRequest,
  type ModelProviderManifest,
  type UpdateModelProviderRequest,
} from '../schemas/modelProvider';
import { MissingStoredSecretError, resolveStoredSecretValue, SECRET_REDACTION } from '../utils/secretRedaction';

export interface ModelProvidersRouterDeps<TTransaction> {
  resolveModelProviderStore: (c: Context) => IModelProviderStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
  /** Providers whose record the environment rewrites at startup; the API keeps them read-only. */
  envManagedNames: ReadonlySet<string>;
}

/** Machine-readable `error.code` when a write targets an environment-managed provider. */
export const ENV_MANAGED_PROVIDER_CODE = 'env_managed_provider';

/** What a person is told when a provider that needs a key is saved without one. */
const API_KEY_REQUIRED_MESSAGE = 'API key is required. Add an API key for this provider, then save again.';

function envManagedConflict(name: string) {
  return {
    error: {
      message: `Model provider ${name} is managed by the server environment and cannot be changed here.`,
      type: 'conflict',
      code: ENV_MANAGED_PROVIDER_CODE,
    },
  };
}

function redactModelProvider(manifest: ModelProviderManifest): ModelProviderManifest {
  if (manifest.auth === undefined) {
    return manifest;
  }
  return {
    ...manifest,
    auth: { api_key: SECRET_REDACTION },
  };
}

/** Provider types whose key is optional even when they are first set up: a local endpoint may need none. */
function providerNeedsKeyAtSetup(manifest: ModelProviderManifest): boolean {
  return manifest.type !== 'custom' && manifest.type !== 'truefoundry';
}

function resolveModelProviderManifestForWrite({
  incoming,
  existing,
}: {
  incoming: ModelProviderManifest;
  existing: ModelProviderManifest | undefined;
}): ModelProviderManifest {
  if (incoming.auth === undefined) {
    if (!providerNeedsKeyAtSetup(incoming)) {
      return incoming;
    }
    // No key named on a write that needs one: an update keeps the stored key,
    // and a first setup without one is refused, as before.
    if (existing?.auth !== undefined) {
      return { ...incoming, auth: existing.auth };
    }
    throw new MissingStoredSecretError();
  }
  const existingApiKey = existing?.auth?.api_key;
  return {
    ...incoming,
    auth: {
      api_key: resolveStoredSecretValue({
        incoming: incoming.auth.api_key,
        existing: existingApiKey,
      }),
    },
  };
}

function toWireProvider({
  record,
  envManagedNames,
}: {
  record: ModelProviderRecord;
  envManagedNames: ReadonlySet<string>;
}): ConfiguredModelProvider {
  return {
    name: record.name,
    manifest: redactModelProvider(record.manifest),
    ...(envManagedNames.has(record.name) ? { env_managed: true } : {}),
  };
}

export function createModelProvidersRouter<TTransaction>(deps: ModelProvidersRouterDeps<TTransaction>) {
  const listHandler: RouteHandler<typeof listModelProvidersRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const records = await deps.resolveModelProviderStore(c).listProviders({ tenant_id: requestContext.tenant_id });
    return c.json(
      { data: records.map(record => toWireProvider({ record, envManagedNames: deps.envManagedNames })) },
      200,
    );
  };

  const createHandler: RouteHandler<typeof createModelProviderRoute> = async c => {
    const body: CreateModelProviderRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const provider = body.manifest;
    const name = modelProviderName(provider);
    if (deps.envManagedNames.has(name)) {
      return c.json(envManagedConflict(name), 409);
    }
    try {
      // Create has no prior row; redacted keep resolves to MissingStoredSecretError → 400.
      const manifest = resolveModelProviderManifestForWrite({ incoming: provider, existing: undefined });
      const record = await deps.resolveModelProviderStore(c).createProvider({
        tenant_id: requestContext.tenant_id,
        name,
        manifest,
      });
      return c.json({ data: toWireProvider({ record, envManagedNames: deps.envManagedNames }) }, 201);
    } catch (error) {
      if (error instanceof MissingStoredSecretError) {
        return c.json({ error: { message: API_KEY_REQUIRED_MESSAGE } }, 400);
      }
      if (error instanceof ModelProviderNameConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const putHandler: RouteHandler<typeof putModelProviderRoute> = async c => {
    const store = deps.resolveModelProviderStore(c);
    const body: UpdateModelProviderRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const provider = body.manifest;
    const name = modelProviderName(provider);
    if (deps.envManagedNames.has(name)) {
      return c.json(envManagedConflict(name), 409);
    }
    try {
      // Lock → resolve secret from that snapshot → upsert, all in one txn so concurrent keep
      // cannot re-write a secret over a rotate that committed in between.
      const record = await deps.withTransaction(async transaction => {
        const existing = await store.getProviderForUpdate({ tenant_id: requestContext.tenant_id, name }, transaction);
        const manifest = resolveModelProviderManifestForWrite({
          incoming: provider,
          existing: existing?.manifest,
        });
        return store.upsertProvider({ tenant_id: requestContext.tenant_id, name, manifest }, transaction);
      });
      return c.json({ data: toWireProvider({ record, envManagedNames: deps.envManagedNames }) }, 200);
    } catch (error) {
      if (error instanceof MissingStoredSecretError) {
        return c.json({ error: { message: API_KEY_REQUIRED_MESSAGE } }, 400);
      }
      throw error;
    }
  };

  const deleteHandler: RouteHandler<typeof deleteModelProviderRoute> = async c => {
    const { name } = c.req.valid('param');
    if (deps.envManagedNames.has(name)) {
      return c.json(envManagedConflict(name), 409);
    }
    const requestContext = deps.resolveRequestContext(c);
    // model_name is unused by deleteProvider (row is keyed by tenant_id + name); GetModelProviderInput
    // is shared with getProvider, which does need it.
    const deleted = await deps
      .resolveModelProviderStore(c)
      .deleteProvider({ tenant_id: requestContext.tenant_id, name, model_name: '' });
    if (!deleted) {
      return c.json({ error: { message: `No model provider with this name: ${name}` } }, 404);
    }
    return c.json({}, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listModelProvidersRoute, listHandler);
  router.openapi(createModelProviderRoute, createHandler);
  router.openapi(putModelProviderRoute, putHandler);
  router.openapi(deleteModelProviderRoute, deleteHandler);
  return router;
}
