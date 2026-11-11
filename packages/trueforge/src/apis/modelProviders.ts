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
  isThisComputerModelUrl,
  MODEL_ON_THIS_COMPUTER_CODE,
  modelOnThisComputerMessage,
  type LocalModels,
  type ResolveHostAddresses,
} from '../runtime/localModels';
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
  /** This computer and the local model bridge, so a model address that is this computer is steered to the bridge. */
  localModels: LocalModels;
  /** Name lookups for that check; tests replace it so no lookup leaves the machine. */
  resolveHostAddresses?: ResolveHostAddresses;
}

/** Machine-readable `error.code` when a write targets an environment-managed provider. */
export const ENV_MANAGED_PROVIDER_CODE = 'env_managed_provider';

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

function resolveModelProviderManifestForWrite({
  incoming,
  existing,
}: {
  incoming: ModelProviderManifest;
  existing: ModelProviderManifest | undefined;
}): ModelProviderManifest {
  if (!('auth' in incoming) || incoming.auth === undefined) {
    return incoming;
  }
  const existingApiKey = existing && 'auth' in existing ? existing.auth?.api_key : undefined;
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

/**
 * The refusal for a model address that is this computer, or undefined when the address is fine to save. A model on
 * this computer reached by one of its network addresses fails without warning when that address stops answering the
 * app's containers, so it is never stored. The bridge is offered instead.
 */
async function modelOnThisComputerRefusal({
  manifest,
  localModels,
  resolveHostAddresses,
}: {
  manifest: ModelProviderManifest;
  localModels: LocalModels;
  resolveHostAddresses: ResolveHostAddresses | undefined;
}) {
  const onThisComputer = await isThisComputerModelUrl({
    baseUrl: manifest.base_url,
    local: localModels,
    ...(resolveHostAddresses === undefined ? {} : { resolveHostAddresses }),
  });
  if (!onThisComputer) {
    return undefined;
  }
  return {
    error: {
      message: modelOnThisComputerMessage({ baseUrl: manifest.base_url, local: localModels }),
      type: 'invalid_request',
      code: MODEL_ON_THIS_COMPUTER_CODE,
      param: 'manifest.base_url',
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
    const refusal = await modelOnThisComputerRefusal({
      manifest: provider,
      localModels: deps.localModels,
      resolveHostAddresses: deps.resolveHostAddresses,
    });
    if (refusal !== undefined) {
      return c.json(refusal, 400);
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
        return c.json({ error: { message: 'API key is required' } }, 400);
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
    // Before the transaction: the check may look a name up.
    const refusal = await modelOnThisComputerRefusal({
      manifest: provider,
      localModels: deps.localModels,
      resolveHostAddresses: deps.resolveHostAddresses,
    });
    if (refusal !== undefined) {
      return c.json(refusal, 400);
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
        return c.json({ error: { message: 'API key is required' } }, 400);
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
