import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Context } from 'hono';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import configuration from '../config';
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
import type { CheckSavedModelProvider } from '../runtime/modelProviderCheck';
import { modelUrlProblem } from '../runtime/remoteAddress';
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
  /** Runs the one test call for a just-saved provider; its outcome is stored on the provider. */
  checkSavedProvider: CheckSavedModelProvider;
  logger: Logger;
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

/**
 * The reason a model base address may not be saved, or undefined when it may. The one exception
 * is an exact endpoint the operator named in `LOCAL_MODEL_ENDPOINTS`: a model running on this
 * computer is allowed once its host and port are named there. Every other address is resolved
 * and judged by the address check (see runtime/remoteAddress) before it is written. A host that
 * does not resolve is not refused: it connects nowhere, and the address is judged again when
 * the model is used.
 */
async function modelAddressRefusal({ baseUrl }: { baseUrl: string | undefined }): Promise<string | undefined> {
  if (baseUrl === undefined) {
    return undefined;
  }
  const problem = await modelUrlProblem({ url: baseUrl, endpoints: configuration.LOCAL_MODEL_ENDPOINTS });
  switch (problem) {
    case null:
    case 'unresolved':
      return undefined;
    case 'blocked':
      return "That address is on this computer, so the server cannot use it for a model. To use a model on this computer, name its exact address (host and port) in LOCAL_MODEL_ENDPOINTS. On an installed Aman, that setting is in the instance's settings file, ~/.amanuensis/instances/<name>/.env, below the block the installer manages. Restart the instance after changing it.";
    case 'invalid':
      return 'That address is not one the server can connect to. Enter the full address, starting with http:// or https://, without a name and password in it.';
  }
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
    ...(record.last_check === null ? {} : { last_check: record.last_check }),
  };
}

/**
 * Runs the save-time connection check for a provider that was just saved and stores the
 * outcome on its row, returning the record to present. The check warns and never blocks:
 * if the check or the store write itself fails, the saved provider is returned as it was
 * and the failure is only logged.
 */
async function runSaveCheck<TTransaction>({
  deps,
  store,
  tenant_id,
  record,
}: {
  deps: ModelProvidersRouterDeps<TTransaction>;
  store: IModelProviderStore<TTransaction>;
  tenant_id: string;
  record: ModelProviderRecord;
}): Promise<ModelProviderRecord> {
  try {
    const check = await deps.checkSavedProvider({ tenant_id, store, record });
    const updated = await store.recordProviderCheck({ tenant_id, name: record.name, check });
    return updated ?? { ...record, last_check: check };
  } catch (error) {
    deps.logger.error('Model provider connection check failed to run', extractErrorLogFields(error));
    return record;
  }
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
    const refusal = await modelAddressRefusal({ baseUrl: provider.base_url });
    if (refusal !== undefined) {
      return c.json({ error: { message: refusal } }, 400);
    }
    try {
      // Create has no prior row; redacted keep resolves to MissingStoredSecretError → 400.
      const manifest = resolveModelProviderManifestForWrite({ incoming: provider, existing: undefined });
      const store = deps.resolveModelProviderStore(c);
      const saved = await store.createProvider({
        tenant_id: requestContext.tenant_id,
        name,
        manifest,
      });
      const record = await runSaveCheck({ deps, store, tenant_id: requestContext.tenant_id, record: saved });
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
    // Before the transaction: the check resolves the address, and remote I/O stays out of the
    // write transaction.
    const refusal = await modelAddressRefusal({ baseUrl: provider.base_url });
    if (refusal !== undefined) {
      return c.json({ error: { message: refusal } }, 400);
    }
    try {
      // Lock → resolve secret from that snapshot → upsert, all in one txn so concurrent keep
      // cannot re-write a secret over a rotate that committed in between. The connection check
      // runs after the transaction commits: it makes a network call, which never belongs
      // inside a transaction.
      const saved = await deps.withTransaction(async transaction => {
        const existing = await store.getProviderForUpdate({ tenant_id: requestContext.tenant_id, name }, transaction);
        const manifest = resolveModelProviderManifestForWrite({
          incoming: provider,
          existing: existing?.manifest,
        });
        return store.upsertProvider({ tenant_id: requestContext.tenant_id, name, manifest }, transaction);
      });
      const record = await runSaveCheck({ deps, store, tenant_id: requestContext.tenant_id, record: saved });
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
