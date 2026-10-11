import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { SANDBOX_IMAGE_URI, withTimeout } from '@truefoundry/trueforge-core/core';
import type { Context } from 'hono';
import { isDeepStrictEqual } from 'node:util';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import type { ISandboxProviderStore, SandboxProviderRecord } from '../db/sandboxProviderStore';
import type { WithTransaction } from '../db/transaction';
import {
  getSandboxProviderRoute,
  putSandboxProviderRoute,
  upgradeSandboxProviderImageRoute,
} from '../routes/sandboxProviderRoutes';
import {
  checkSnapshotStatus,
  isDaytonaAuthError,
  isDaytonaPermissionError,
  toDaytonaSandboxProvider,
  toSandboxStatus,
} from '../sandbox/providerUtils';
import type { SandboxProviderManifest, UpdateSandboxProviderRequest } from '../schemas/sandboxProvider';
import { MissingStoredSecretError, resolveStoredSecretValue, SECRET_REDACTION } from '../utils/secretRedaction';

/** Cap the Daytona register round-trip so a slow/unreachable provider can't hold the request (or DB txn) open. */
const BUILD_REQUEST_TIMEOUT_MS = 3_000;

export interface SandboxProvidersRouterDeps<TTransaction> {
  resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  logger: Logger;
  resolveRequestContext: ResolveRequestContext;
}

function redactSandboxProvider(manifest: SandboxProviderManifest): SandboxProviderManifest {
  return {
    ...manifest,
    auth: { api_key: SECRET_REDACTION },
  };
}

function providerResponse(
  record: Pick<SandboxProviderRecord, 'status' | 'status_reason'> & { manifest: SandboxProviderManifest },
) {
  return {
    data: {
      manifest: redactSandboxProvider(record.manifest),
      status: record.status,
      status_reason: record.status_reason,
    },
  };
}

type UpgradeImageResult =
  { outcome: 'missing' } | { outcome: 'changed' } | { outcome: 'current' | 'updated'; record: SandboxProviderRecord };

/** Admin/settings sandbox provider surface (mounted at /api/v1/settings/sandbox-providers). */
export function createSandboxProvidersRouter<TTransaction>(deps: SandboxProvidersRouterDeps<TTransaction>) {
  const upgradeImageInFlight = new Map<string, Promise<UpgradeImageResult>>();

  const getHandler: RouteHandler<typeof getSandboxProviderRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const store = deps.resolveSandboxProviderStore(c);
    const record = await store.getSandboxProvider(requestContext.tenant_id);
    if (record?.manifest.type !== 'daytona') {
      return c.json({ error: { message: 'No sandbox provider configured' } }, 404);
    }
    // Refresh the persisted build status (and re-activate an idle snapshot) on every GET.
    const status = await checkSnapshotStatus({
      store,
      tenant_id: requestContext.tenant_id,
      logger: deps.logger,
    });
    return c.json(
      {
        data: {
          manifest: redactSandboxProvider(record.manifest),
          status: status?.status ?? record.status,
          status_reason: status?.status_reason ?? record.status_reason,
        },
      },
      200,
    );
  };

  const putHandler: RouteHandler<typeof putSandboxProviderRoute> = async c => {
    const body: UpdateSandboxProviderRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const store = deps.resolveSandboxProviderStore(c);
    const incoming = body.manifest;
    const resolveManifest = (existing: SandboxProviderRecord | undefined): SandboxProviderManifest => ({
      ...incoming,
      auth: {
        api_key: resolveStoredSecretValue({
          incoming: incoming.auth.api_key,
          existing: existing?.manifest.type === 'daytona' ? existing.manifest.auth.api_key : undefined,
        }),
      },
    });
    try {
      // NOTE: build (Daytona network I/O) runs inside the transaction for now; the design is being revisited.
      const { manifest, status } = await deps.withTransaction(async transaction => {
        const locked = await store.getSandboxProviderForUpdate(requestContext.tenant_id, transaction);
        const resolved = resolveManifest(locked);
        // Pass persisted build_metadata so a settings re-save does not start a new snapshot for a
        // bumped SANDBOX_IMAGE_URI. Image upgrades use the explicit upgrade action below.
        const provider = toDaytonaSandboxProvider({
          manifest: resolved,
          tenant_id: requestContext.tenant_id,
          logger: deps.logger,
          ...(locked ? { build_metadata: locked.build_metadata } : {}),
        });
        const built = toSandboxStatus(
          await withTimeout(provider.buildImage(), BUILD_REQUEST_TIMEOUT_MS, 'sandbox buildImage'),
        );
        await store.upsertSandboxProvider(
          { tenant_id: requestContext.tenant_id, manifest: resolved, ...built },
          transaction,
        );
        return { manifest: resolved, status: built };
      });
      return c.json(
        {
          data: {
            manifest: redactSandboxProvider(manifest),
            status: status.status,
            status_reason: status.status_reason,
          },
        },
        200,
      );
    } catch (error) {
      if (error instanceof MissingStoredSecretError) {
        return c.json({ error: { message: 'API key is required' } }, 400);
      }
      if (isDaytonaAuthError(error)) {
        return c.json({ error: { message: 'Daytona rejected the API key — check the credentials' } }, 422);
      }
      if (isDaytonaPermissionError(error)) {
        return c.json(
          {
            error: {
              message:
                'Daytona denied access: the API key is missing required permissions. Grant write:sandboxes, write:snapshots, and delete:snapshots on the key in the Daytona dashboard, then try again.',
            },
          },
          422,
        );
      }
      throw error;
    }
  };

  const performImageUpgrade = async (params: {
    providerId: string;
    tenant_id: string;
    store: ISandboxProviderStore<TTransaction>;
  }): Promise<UpgradeImageResult> => {
    const { providerId, tenant_id, store } = params;
    const existing = await store.getSandboxProvider(tenant_id);
    if (existing?.manifest.type !== 'daytona' || existing.manifest.type !== providerId) {
      return { outcome: 'missing' };
    }

    const alreadyCurrent =
      existing.build_metadata?.['image_uri'] === SANDBOX_IMAGE_URI &&
      (existing.status === 'ready' || existing.status === 'pending');
    if (alreadyCurrent) {
      return { outcome: 'current', record: existing };
    }

    // Image registration is remote I/O. Never hold a database transaction while it runs.
    const provider = toDaytonaSandboxProvider({
      manifest: existing.manifest,
      tenant_id,
      logger: deps.logger,
    });
    const built = toSandboxStatus(
      await withTimeout(provider.buildImage(), BUILD_REQUEST_TIMEOUT_MS, 'sandbox buildImage'),
    );

    const finalized = await deps.withTransaction<UpgradeImageResult>(async transaction => {
      const locked = await store.getSandboxProviderForUpdate(tenant_id, transaction);
      if (locked === undefined) {
        return { outcome: 'missing' };
      }
      if (!isDeepStrictEqual(locked.manifest, existing.manifest)) {
        return { outcome: 'changed' };
      }
      const updated = await store.updateSandboxStatus({ tenant_id, ...built }, transaction);
      return updated === undefined ? { outcome: 'missing' } : { outcome: 'updated', record: updated };
    });

    if ((finalized.outcome === 'missing' || finalized.outcome === 'changed') && built.build_metadata !== null) {
      // Daytona build refs are deterministic release artifacts shared across server replicas. A
      // losing local publication must not delete the snapshot: another replica may have received
      // 409 for the same build ref and already persisted it. Keep it as a reusable release cache.
      deps.logger.warn('Sandbox provider changed after release image registration; retaining shared snapshot', {
        provider_id: providerId,
        build_ref: built.build_metadata['build_ref'],
        image_uri: built.build_metadata['image_uri'],
      });
    }
    return finalized;
  };

  const coalescedImageUpgrade = (params: {
    providerId: string;
    tenant_id: string;
    store: ISandboxProviderStore<TTransaction>;
  }): Promise<UpgradeImageResult> => {
    const { providerId } = params;
    const inFlight = upgradeImageInFlight.get(providerId);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const started = performImageUpgrade(params);
    upgradeImageInFlight.set(providerId, started);
    const clearIfCurrent = () => {
      if (upgradeImageInFlight.get(providerId) === started) {
        upgradeImageInFlight.delete(providerId);
      }
    };
    void started.then(clearIfCurrent, clearIfCurrent);
    return started;
  };

  const upgradeImageHandler: RouteHandler<typeof upgradeSandboxProviderImageRoute> = async c => {
    const { provider_id: providerId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    try {
      const result = await coalescedImageUpgrade({
        providerId,
        tenant_id: requestContext.tenant_id,
        store: deps.resolveSandboxProviderStore(c),
      });
      if (result.outcome === 'missing') {
        return c.json({ error: { message: 'No sandbox provider configured' } }, 404);
      }
      if (result.outcome === 'changed') {
        return c.json(
          { error: { message: 'Sandbox provider configuration changed while its image was upgrading; retry' } },
          409,
        );
      }
      const { record } = result;
      if (record.manifest.type !== 'daytona') {
        return c.json({ error: { message: 'No sandbox provider configured' } }, 404);
      }
      return c.json(providerResponse({ ...record, manifest: record.manifest }), 200);
    } catch (error) {
      if (isDaytonaAuthError(error)) {
        return c.json({ error: { message: 'Daytona rejected the API key — check the credentials' } }, 422);
      }
      if (isDaytonaPermissionError(error)) {
        return c.json(
          {
            error: {
              message:
                'Daytona denied access: the API key is missing required permissions. Grant write:sandboxes, write:snapshots, and delete:snapshots on the key in the Daytona dashboard, then try again.',
            },
          },
          422,
        );
      }
      throw error;
    }
  };

  const router = new OpenAPIHono();
  router.openapi(getSandboxProviderRoute, getHandler);
  router.openapi(putSandboxProviderRoute, putHandler);
  router.openapi(upgradeSandboxProviderImageRoute, upgradeImageHandler);
  return router;
}
