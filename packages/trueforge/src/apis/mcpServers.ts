import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import {
  extractErrorLogFields,
  isAuthRequired,
  McpConnectionError,
  RemoteMCP,
  type RemoteMcpHeaders,
} from '@truefoundry/trueforge-core/core';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash } from 'node:crypto';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import { safeReturnTo } from '../auth/safeReturnTo';
import type { McpCatalog } from '../catalog/McpCatalog';
import configuration from '../config';
import {
  McpServerNameConflictError,
  McpServerNotFoundError,
  type IMcpServerStore,
  type IMcpServerWithAuthStore,
  type McpServerRecord,
} from '../db/mcpServerStore';
import type { IMcpToolGrantStore } from '../db/mcpToolGrantStore';
import type { WithTransaction } from '../db/transaction';
import { createMcpOAuthClient } from '../mcp/auth/mcpDcr';
import { mcpOAuthRedirectUris } from '../mcp/auth/mcpOAuthHelpers';
import type { IOAuthTokenStore, OAuthClientRecord } from '../mcp/auth/types';
import { connectorIdentity } from '../mcp/connectorIdentity';
import { firstPartyAfterSave } from '../mcp/firstParty';
import {
  authorizeMcpServerRoute,
  createMcpServerRoute,
  deleteAuthorizationMcpServerRoute,
  deleteMcpServerRoute,
  deleteMcpToolGrantRoute,
  getAvailableMcpServerRoute,
  getMcpServerRoute,
  listAvailableMcpServersRoute,
  listMcpServersRoute,
  listMcpServerToolsRoute,
  listMcpToolGrantsRoute,
  memoryCheckMcpServerRoute,
  putMcpServerRoute,
} from '../routes/mcpServerRoutes';
import { checkMemoryProviderUrl, type MemoryProviderCheckOutcome } from '../runtime/memory/memoryProbe';
import { getMcpConnection, resolveManifestRequestHeaders } from '../runtime/sessionResources';
import type {
  AvailableMcpServer,
  ConfiguredMcpServer,
  CreateMcpServerRequest,
  McpAuthStatus,
  McpServerManifest,
  UpdateMcpServerRequest,
} from '../schemas/mcpServer';
import type { MemoryProviderCheckResult } from '../schemas/memoryProvider';
import { MissingStoredSecretError, resolveStoredSecretValue, SECRET_REDACTION } from '../utils/secretRedaction';
import { isSecretReference } from '../utils/secretReferences';

export interface McpServersRouterDeps<TTransaction> {
  resolveMcpServerStore: (c: Context) => IMcpServerWithAuthStore<TTransaction>;
  tokenStore: IOAuthTokenStore<TTransaction>;
  toolGrantStore: IMcpToolGrantStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  logger: Logger;
  resolveRequestContext: ResolveRequestContext;
}

/** Omits keys whose value is `undefined` so wire objects satisfy JSONValue index signatures. */
function omitUndefinedEntries(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Settings wire view: redact header secrets and oauth_client secrets; leave DCR / no-auth manifests unchanged.
 * A `${env:NAME}` / `${file:PATH}` reference is a pointer, not a secret — it passes through
 * unredacted so the user can see and edit it, and so a later PUT of the same reference is an
 * ordinary value change rather than a "keep the stored secret" no-op.
 */
function redactMcpServerManifest(manifest: McpServerManifest): McpServerManifest {
  if (manifest.auth?.type === 'header') {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(manifest.auth.headers)) {
      headers[name] = isSecretReference(value) ? value : SECRET_REDACTION;
    }
    return {
      ...manifest,
      auth: { type: 'header', headers },
    };
  }
  if (manifest.auth?.type === 'oauth_client') {
    const clientSecret = isSecretReference(manifest.auth.client_secret)
      ? manifest.auth.client_secret
      : SECRET_REDACTION;
    return {
      ...manifest,
      auth: {
        type: 'oauth_client',
        client_id: manifest.auth.client_id,
        client_secret: clientSecret,
        ...(manifest.auth.scopes !== undefined ? { scopes: manifest.auth.scopes } : {}),
      },
    };
  }
  return manifest;
}

/** Connector roles of which exactly one configured server may hold the flag. */
type SingleHolderRole = 'memory_provider' | 'search_provider';

/**
 * Only one configured server may hold each single-holder role: the host recalls from and retains to
 * exactly one memory connector, and routes the user's silent searches through exactly one search
 * connector. `excludeName` skips the row being written itself, so re-saving the server that already
 * holds the flag is not treated as a conflict with itself. Returns the first other flagged server
 * found, or undefined when there is none.
 */
async function findOtherRoleHolder({
  mcpServerStore,
  tenant_id,
  excludeName,
  role,
}: {
  mcpServerStore: IMcpServerStore;
  tenant_id: string;
  excludeName: string;
  role: SingleHolderRole;
}): Promise<McpServerRecord | undefined> {
  const servers = await mcpServerStore.listServers({ tenant_id, names: undefined });
  return servers.find(
    server => server.name !== excludeName && server.manifest.type === 'remote' && server.manifest[role] === true,
  );
}

function dcrUnauthorizedReason(name: string): string {
  return `connector "${name}" must be saved and authorized before it can be checked`;
}

/**
 * Why a DCR manifest will have no usable token once the write lands, or undefined when the
 * stored authorization survives it. A DCR token is keyed by the row id and scoped to the MCP
 * URL, so only a re-save of an already-authorized DCR connector at an unchanged URL keeps it:
 * a brand-new connector, a switch from header auth, and a URL change all commit a row whose
 * token does not exist yet or is about to be deleted.
 */
function dcrAuthorizationGap({
  manifest,
  stored,
}: {
  manifest: McpServerManifest;
  stored: McpServerRecord | undefined;
}): string | undefined {
  if (stored === undefined || stored.manifest.auth?.type !== 'dcr') {
    return dcrUnauthorizedReason(manifest.name);
  }
  if (stored.manifest.url !== manifest.url) {
    return `changing the URL of "${manifest.name}" clears its authorization, so it must be authorized again before it can serve memory`;
  }
  return undefined;
}

/**
 * Runs the memory-provider connection check for the manifest a write is about to commit,
 * resolving its live request headers exactly as a turn would. A connector's `auth_status` only
 * covers its MCP endpoint, while host-enforced memory calls the Hindsight REST API behind the
 * same host, so this is the only signal that says the credential memory will use actually works.
 *
 * Credentials come from the incoming manifest, never from whatever the row happens to hold now:
 * a header-to-DCR switch must not pass on the header it replaces, and a DCR URL change must not
 * pass on the token the write then deletes. DCR is the one case that legitimately reads stored
 * state, and only where {@link dcrAuthorizationGap} says the stored token outlives the write.
 */
async function checkMemoryProvider({
  manifest,
  stored,
  mcpServerStore,
  tokenStore,
  tenant_id,
  userRef,
}: {
  manifest: McpServerManifest;
  stored: McpServerRecord | undefined;
  mcpServerStore: IMcpServerStore;
  tokenStore: IOAuthTokenStore;
  tenant_id: string;
  userRef: string;
}): Promise<MemoryProviderCheckOutcome> {
  let headers: RemoteMcpHeaders;
  if (manifest.auth?.type === 'dcr') {
    const gap = dcrAuthorizationGap({ manifest, stored });
    if (gap !== undefined) {
      return { ok: false, code: 'auth_required', reason: gap };
    }
    const connection = await getMcpConnection({
      tenant_id,
      name: manifest.name,
      store: mcpServerStore,
      tokenStore,
      clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
      userRef,
    });
    if (connection === undefined) {
      return { ok: false, code: 'auth_required', reason: dcrUnauthorizedReason(manifest.name) };
    }
    headers = connection.headers;
  } else {
    headers = resolveManifestRequestHeaders(manifest);
  }
  return checkMemoryProviderUrl({
    url: manifest.url,
    headers,
    // A bank tuned to a long recall deadline must not fail its own save check sooner than a turn.
    timeoutMs: Math.max(
      configuration.MEMORY_CHECK_TIMEOUT_MS,
      (manifest.type === 'remote' ? manifest.memory_settings?.recall_timeout_ms : undefined) ??
        configuration.MEMORY_RECALL_TIMEOUT_MS,
    ),
  });
}

/**
 * Digest of everything the memory-provider check authenticated with: the URL it dialed, the auth
 * the row will carry, and the identity of the row a DCR token hangs off. The check runs on an
 * unlocked read, so the write transaction re-derives this under its row lock and refuses to
 * commit a URL and credential pair that never passed. Hashed rather than compared raw so a header
 * secret never survives in a comparison value.
 */
function memoryProviderProbeDigest({
  manifest,
  stored,
}: {
  manifest: McpServerManifest;
  stored: McpServerRecord | undefined;
}): string {
  const probed = JSON.stringify({
    url: manifest.url,
    auth: manifest.auth ?? null,
    stored_id: stored?.id ?? null,
  });
  return createHash('sha256').update(probed).digest('hex');
}

/**
 * The connector changed between the unlocked read the memory-provider check ran on and the write
 * transaction that locks it. Reported as the conflict the rest of this router uses, so the caller
 * retries against current state instead of saving credentials nothing verified.
 */
class MemoryProviderCheckStaleError extends Error {
  constructor(name: string) {
    super(`connector "${name}" changed while its memory provider check was running; retry the save`);
    this.name = 'MemoryProviderCheckStaleError';
  }
}

/** Wire projection of a check outcome; the runtime shape is camelCase, the wire is snake_case. */
function toMemoryProviderCheckResult(outcome: MemoryProviderCheckOutcome): MemoryProviderCheckResult {
  if (outcome.ok) {
    return { status: 'ok' };
  }
  return {
    status: 'failed',
    code: outcome.code,
    reason: outcome.reason,
    ...(outcome.httpStatus === undefined ? {} : { http_status: outcome.httpStatus }),
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  };
}

/**
 * Strict PUT merge for `auth.type === 'header'`: each header value is always required;
 * redacted values keep the stored secret for the same header name. A `${env:NAME}` /
 * `${file:PATH}` reference needs no special case here: it is never a redacted stand-in (it never
 * contains the redaction sentinel), so `resolveStoredSecretValue` already treats writing one as an
 * ordinary new value — replacing a stored literal or a stored reference alike.
 * @throws {MissingStoredSecretError} when keep is requested without a stored header value
 */
function resolveMcpServerManifestForWrite({
  incoming,
  existing,
}: {
  incoming: McpServerManifest;
  existing: McpServerManifest | undefined;
}): McpServerManifest {
  if (incoming.auth?.type === 'header') {
    const existingHeaders = existing?.auth?.type === 'header' ? existing.auth.headers : undefined;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(incoming.auth.headers)) {
      headers[name] = resolveStoredSecretValue({
        incoming: value,
        existing: existingHeaders?.[name],
      });
    }
    return {
      ...incoming,
      auth: { type: 'header', headers },
    };
  }
  if (incoming.auth?.type === 'oauth_client') {
    const existingSecret = existing?.auth?.type === 'oauth_client' ? existing.auth.client_secret : undefined;
    const clientSecret = resolveStoredSecretValue({
      incoming: incoming.auth.client_secret,
      existing: existingSecret,
    });
    return {
      ...incoming,
      auth: {
        type: 'oauth_client',
        client_id: incoming.auth.client_id,
        client_secret: clientSecret,
        ...(incoming.auth.scopes !== undefined ? { scopes: incoming.auth.scopes } : {}),
      },
    };
  }
  return incoming;
}

async function toConfiguredMcpServer<TTransaction>(params: {
  store: IMcpServerWithAuthStore<TTransaction>;
  record: McpServerRecord;
  userRef: string;
}): Promise<ConfiguredMcpServer> {
  const statuses = await params.store.resolveAuthStatuses({
    records: [params.record],
    userRef: params.userRef,
  });
  return {
    name: params.record.name,
    manifest: redactMcpServerManifest(params.record.manifest),
    auth_status: statuses.get(params.record.name) ?? { status: 'auth_required' },
  };
}

function toAvailableMcpServer(params: { record: McpServerRecord; authStatus: McpAuthStatus }): AvailableMcpServer {
  const authType = params.record.manifest.auth?.type;
  return {
    name: params.record.name,
    url: params.record.manifest.url,
    ...(authType !== undefined ? { auth: { type: authType } } : {}),
    auth_status: params.authStatus,
  };
}

async function resolveAvailableMcpServer<TTransaction>(params: {
  store: IMcpServerWithAuthStore<TTransaction>;
  record: McpServerRecord;
  userRef: string;
}): Promise<AvailableMcpServer> {
  const statuses = await params.store.resolveAuthStatuses({
    records: [params.record],
    userRef: params.userRef,
  });
  return toAvailableMcpServer({
    record: params.record,
    authStatus: statuses.get(params.record.name) ?? { status: 'auth_required' },
  });
}

/** Admin/settings MCP CRUD (mounted at /api/v1/settings/mcp-servers). */
/**
 * `search_tools` is the shipped catalog's say alone: whatever the request carried is replaced, so a
 * client cannot widen what runs without asking. Only the web search provider carries the list.
 */
function withCatalogSearchTools({
  manifest,
  mcpCatalog,
}: {
  manifest: McpServerManifest;
  mcpCatalog: McpCatalog;
}): McpServerManifest {
  if (manifest.type !== 'remote') {
    return manifest;
  }
  const tools = manifest.search_provider === true ? mcpCatalog.searchToolsForUrl(manifest.url) : [];
  return { ...manifest, search_tools: tools.length > 0 ? [...tools] : undefined };
}

export function createSettingsMcpServersRouter<TTransaction>(
  deps: McpServersRouterDeps<TTransaction> & { mcpCatalog: McpCatalog },
) {
  /**
   * The message to reject a memory-provider write with, or undefined when the check passed.
   * Callers run this only for a manifest that sets the flag: a connector that is not the memory
   * provider is never dialed on save.
   */
  async function memoryProviderWriteRejection({
    manifest,
    stored,
    mcpServerStore,
    tenant_id,
    userRef,
  }: {
    manifest: McpServerManifest;
    stored: McpServerRecord | undefined;
    mcpServerStore: IMcpServerStore<TTransaction>;
    tenant_id: string;
    userRef: string;
  }): Promise<string | undefined> {
    const outcome = await checkMemoryProvider({
      manifest,
      stored,
      mcpServerStore,
      tokenStore: deps.tokenStore,
      tenant_id,
      userRef,
    });
    if (outcome.ok) {
      return undefined;
    }
    deps.logger.warn(`Memory provider check failed for "${manifest.name}"; rejecting write`, {
      code: outcome.code,
      reason: outcome.reason,
      ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
    });
    return `memory provider check failed: ${outcome.reason}`;
  }

  const listHandler: RouteHandler<typeof listMcpServersRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const userRef = requestContext.subject.id;
    const records = await deps.resolveMcpServerStore(c).listServers({
      tenant_id: requestContext.tenant_id,
      names: undefined,
    });
    const statuses = await deps.resolveMcpServerStore(c).resolveAuthStatuses({
      records,
      userRef,
    });
    const data: ConfiguredMcpServer[] = records.map(record => ({
      name: record.name,
      manifest: redactMcpServerManifest(record.manifest),
      auth_status: statuses.get(record.name) ?? { status: 'auth_required' },
    }));
    return c.json({ data }, 200);
  };

  const getHandler: RouteHandler<typeof getMcpServerRoute> = async c => {
    const { name } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const userRef = requestContext.subject.id;
    const record = await deps.resolveMcpServerStore(c).getServer({
      tenant_id: requestContext.tenant_id,
      name,
    });
    if (!record) {
      return c.json({ error: { message: `MCP server not found: ${name}` } }, 404);
    }
    return c.json(
      {
        data: await toConfiguredMcpServer({
          store: deps.resolveMcpServerStore(c),
          record,
          userRef,
        }),
      },
      200,
    );
  };

  const createHandler: RouteHandler<typeof createMcpServerRoute> = async c => {
    const body: CreateMcpServerRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const incomingManifest = body.manifest;

    if (incomingManifest.type === 'remote' && incomingManifest.memory_provider === true) {
      const conflict = await findOtherRoleHolder({
        mcpServerStore: deps.resolveMcpServerStore(c),
        tenant_id: requestContext.tenant_id,
        excludeName: incomingManifest.name,
        role: 'memory_provider',
      });
      if (conflict !== undefined) {
        return c.json({ error: { message: `memory provider already set on ${conflict.name}; disable it first` } }, 409);
      }
    }
    if (incomingManifest.type === 'remote' && incomingManifest.search_provider === true) {
      const conflict = await findOtherRoleHolder({
        mcpServerStore: deps.resolveMcpServerStore(c),
        tenant_id: requestContext.tenant_id,
        excludeName: incomingManifest.name,
        role: 'search_provider',
      });
      if (conflict !== undefined) {
        return c.json({ error: { message: `search provider already set on ${conflict.name}; disable it first` } }, 409);
      }
    }

    // DCR finishes before the txn (remote I/O stays out of withTransaction on create).
    let dcrClientToSave: OAuthClientRecord | undefined;
    if (incomingManifest.auth?.type === 'dcr') {
      try {
        dcrClientToSave = await createMcpOAuthClient({
          mcpServerUrl: incomingManifest.url,
          mcpServerName: incomingManifest.name,
          redirectUris: mcpOAuthRedirectUris(),
          clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
        });
      } catch (error) {
        deps.logger.error(
          `DCR client registration failed for "${incomingManifest.name}"; rejecting create`,
          extractErrorLogFields(error),
        );
        const message = error instanceof Error ? error.message : 'Failed to register OAuth client for this MCP server';
        return c.json({ error: { message } }, 422);
      }
    }

    let manifest: McpServerManifest;
    try {
      manifest = withCatalogSearchTools({
        manifest: resolveMcpServerManifestForWrite({
          incoming: incomingManifest,
          existing: undefined,
        }),
        mcpCatalog: deps.mcpCatalog,
      });
    } catch (error) {
      if (error instanceof MissingStoredSecretError) {
        return c.json({ error: { message: 'Header secret is required' } }, 400);
      }
      throw error;
    }

    // After secret resolution, so the check dials with the credential the row will actually
    // carry, and before the write, so a provider memory cannot reach is never committed.
    let memoryProviderChecked = false;
    if (manifest.type === 'remote' && manifest.memory_provider === true) {
      // No stored row on create: a name clash is a 409 below, so nothing of an existing row can
      // be inherited by this write, and a DCR manifest has no token yet to check with.
      const rejection = await memoryProviderWriteRejection({
        manifest,
        stored: undefined,
        mcpServerStore: deps.resolveMcpServerStore(c),
        tenant_id: requestContext.tenant_id,
        userRef: requestContext.subject.id,
      });
      if (rejection !== undefined) {
        return c.json({ error: { message: rejection } }, 422);
      }
      memoryProviderChecked = true;
    }

    try {
      const record = await deps.withTransaction(async transaction => {
        const saved = await deps.resolveMcpServerStore(c).createServer(
          {
            tenant_id: requestContext.tenant_id,
            name: manifest.name,
            manifest,
            first_party: firstPartyAfterSave({
              manifest,
              memoryProviderChecked,
              origins: configuration.FIRST_PARTY_MCP_ORIGINS,
            }),
          },
          transaction,
        );
        if (dcrClientToSave !== undefined) {
          await deps.resolveMcpServerStore(c).saveClient({ id: saved.id, record: dcrClientToSave }, transaction);
        }
        return saved;
      });

      return c.json(
        {
          data: await toConfiguredMcpServer({
            store: deps.resolveMcpServerStore(c),
            record,
            userRef: requestContext.subject.id,
          }),
        },
        201,
      );
    } catch (error) {
      if (error instanceof McpServerNameConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const putHandler: RouteHandler<typeof putMcpServerRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const userRef = requestContext.subject.id;
    const body: UpdateMcpServerRequest = c.req.valid('json');
    const incomingManifest = body.manifest;

    if (incomingManifest.type === 'remote' && incomingManifest.memory_provider === true) {
      const conflict = await findOtherRoleHolder({
        mcpServerStore: deps.resolveMcpServerStore(c),
        tenant_id: requestContext.tenant_id,
        excludeName: incomingManifest.name,
        role: 'memory_provider',
      });
      if (conflict !== undefined) {
        return c.json({ error: { message: `memory provider already set on ${conflict.name}; disable it first` } }, 409);
      }
    }
    if (incomingManifest.type === 'remote' && incomingManifest.search_provider === true) {
      const conflict = await findOtherRoleHolder({
        mcpServerStore: deps.resolveMcpServerStore(c),
        tenant_id: requestContext.tenant_id,
        excludeName: incomingManifest.name,
        role: 'search_provider',
      });
      if (conflict !== undefined) {
        return c.json({ error: { message: `search provider already set on ${conflict.name}; disable it first` } }, 409);
      }
    }

    try {
      // Memory-provider check before the write txn, so its network I/O never runs inside a lock
      // and a provider memory cannot reach is never committed. The unlocked read resolves the
      // same stored secrets a redacted header keeps inside the txn below, so the check dials
      // with the credential the row ends up carrying. Every save that leaves the flag on is
      // checked, because a URL or credential edit is exactly what silently breaks recall.
      let probedDigest: string | undefined;
      if (incomingManifest.type === 'remote' && incomingManifest.memory_provider === true) {
        const stored = await deps
          .resolveMcpServerStore(c)
          .getServer({ tenant_id: requestContext.tenant_id, name: incomingManifest.name });
        const probed = resolveMcpServerManifestForWrite({ incoming: incomingManifest, existing: stored?.manifest });
        const rejection = await memoryProviderWriteRejection({
          manifest: probed,
          stored,
          mcpServerStore: deps.resolveMcpServerStore(c),
          tenant_id: requestContext.tenant_id,
          userRef,
        });
        if (rejection !== undefined) {
          return c.json({ error: { message: rejection } }, 422);
        }
        probedDigest = memoryProviderProbeDigest({ manifest: probed, stored });
      }

      // Lock → resolve secrets → DCR (if needed) → upsert + saveClient in one txn.
      // Exception: MCP put may run `createMcpOAuthClient` inside the write txn that persists
      // `oauth_server`/`oauth_client` so a failed registration rolls back the server write.
      // Bounded by `MCP_OAUTH_HTTP_TIMEOUT_MS` (15s);
      // must stay under `POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS` (30s).
      const record = await deps.withTransaction(async transaction => {
        const existing = await deps
          .resolveMcpServerStore(c)
          .getServerForUpdate({ tenant_id: requestContext.tenant_id, name: incomingManifest.name }, transaction);
        const manifest = withCatalogSearchTools({
          manifest: resolveMcpServerManifestForWrite({
            incoming: incomingManifest,
            existing: existing?.manifest,
          }),
          mcpCatalog: deps.mcpCatalog,
        });
        // A concurrent update between the unlocked check above and this lock could otherwise
        // commit a URL and credential pair the provider never answered for.
        if (probedDigest !== undefined && memoryProviderProbeDigest({ manifest, stored: existing }) !== probedDigest) {
          throw new MemoryProviderCheckStaleError(manifest.name);
        }

        let dcrClientToSave: OAuthClientRecord | undefined;
        const urlChanged =
          existing !== undefined && existing.manifest.url !== manifest.url && manifest.auth?.type === 'dcr';
        if (manifest.auth?.type === 'dcr') {
          const existingClient = existing
            ? await deps.resolveMcpServerStore(c).getClient({ id: existing.id }, transaction)
            : undefined;
          // Register when: brand-new server, client was cleared (e.g. invalid_client), or MCP URL changed
          // (resource/AS may differ; reuse would keep stale oauth_server/client for the old AS).
          const needsDcr = existingClient === undefined || urlChanged;
          if (needsDcr) {
            dcrClientToSave = await createMcpOAuthClient({
              mcpServerUrl: manifest.url,
              mcpServerName: manifest.name,
              redirectUris: mcpOAuthRedirectUris(),
              clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
            });
          }
        }

        const saved = await deps.resolveMcpServerStore(c).upsertServer(
          {
            tenant_id: requestContext.tenant_id,
            name: manifest.name,
            manifest,
            // The digest check above proves this exact URL and credential passed the provider check.
            first_party: firstPartyAfterSave({
              manifest,
              memoryProviderChecked: probedDigest !== undefined,
              origins: configuration.FIRST_PARTY_MCP_ORIGINS,
            }),
          },
          transaction,
        );
        if (dcrClientToSave !== undefined) {
          // New DCR registration (create, missing client, or URL change): replace the shared client.
          await deps.resolveMcpServerStore(c).saveClient({ id: saved.id, record: dcrClientToSave }, transaction);
        }
        if (urlChanged) {
          // URL is the OAuth resource/audience — drop every user's tokens and in-flight authorizes.
          await deps.tokenStore.deleteTokensForServer({ id: saved.id }, transaction);
          await deps.tokenStore.deletePendingAuthorizationsForServer({ id: saved.id }, transaction);
        }
        if (
          existing !== undefined &&
          connectorIdentity(existing).fingerprint !== connectorIdentity(saved).fingerprint
        ) {
          // A new URL or new credentials make this a different server to the one Always allow was granted for.
          await deps.toolGrantStore.revokeServerToolGrants(
            { tenant_id: requestContext.tenant_id, mcp_server_name: manifest.name },
            transaction,
          );
        }
        return saved;
      });

      return c.json(
        {
          data: await toConfiguredMcpServer({
            store: deps.resolveMcpServerStore(c),
            record,
            userRef,
          }),
        },
        200,
      );
    } catch (error) {
      if (error instanceof MissingStoredSecretError) {
        return c.json({ error: { message: 'Header secret is required' } }, 400);
      }
      if (error instanceof MemoryProviderCheckStaleError) {
        deps.logger.warn(`Memory provider check went stale for "${incomingManifest.name}"; rejecting upsert`);
        return c.json({ error: { message: error.message } }, 409);
      }
      if (error instanceof McpConnectionError) {
        deps.logger.error(
          `DCR client registration failed for "${incomingManifest.name}"; rejecting upsert`,
          extractErrorLogFields(error),
        );
        return c.json({ error: { message: error.message } }, 422);
      }
      throw error;
    }
  };

  const deleteHandler: RouteHandler<typeof deleteMcpServerRoute> = async c => {
    const { name } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.resolveMcpServerStore(c).getServer({ tenant_id: requestContext.tenant_id, name });
    if (!record) {
      return c.json({ error: { message: `MCP server not found: ${name}` } }, 404);
    }
    // The connector row is shared, so deletion purges EVERY user's tokens, in-flight
    // authorizations, and Always allow grants, not just the caller's, in one transaction with
    // the row itself. The schema declares ON DELETE CASCADE, but SQLite only honors that with
    // the foreign_keys pragma enabled; explicit cleanup is the house pattern (see the URL-change
    // purge in putHandler). A session whose agent spec still names this server hits the existing
    // 422 unregistered-server error on next use; that is intended.
    await deps.withTransaction(async transaction => {
      await deps.tokenStore.deleteTokensForServer({ id: record.id }, transaction);
      await deps.tokenStore.deletePendingAuthorizationsForServer({ id: record.id }, transaction);
      await deps.toolGrantStore.revokeServerToolGrants(
        { tenant_id: requestContext.tenant_id, mcp_server_name: name },
        transaction,
      );
      await deps.resolveMcpServerStore(c).deleteServer({ tenant_id: requestContext.tenant_id, name }, transaction);
    });
    return c.json({}, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listMcpServersRoute, listHandler);
  router.openapi(createMcpServerRoute, createHandler);
  router.openapi(putMcpServerRoute, putHandler);
  router.openapi(getMcpServerRoute, getHandler);
  router.openapi(deleteMcpServerRoute, deleteHandler);
  return router;
}

/** Chat list, tools, and authorize. */
export function createMcpServersRouter<TTransaction>(deps: McpServersRouterDeps<TTransaction>) {
  const authorizeHandler: RouteHandler<typeof authorizeMcpServerRoute> = async c => {
    const { name } = c.req.valid('param');
    const { return_to: returnTo } = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    const userRef = requestContext.subject.id;

    if (returnTo && safeReturnTo(returnTo) !== returnTo) {
      return c.json({ error: { message: 'Invalid return_to: must be a same-origin relative path' } }, 400);
    }

    try {
      // The store owns the whole authorize flow, `dcr` and `oauth_client` (fork-only; see
      // DIVERGENCE.md) alike: header/no-auth resolve to a static status, dcr/oauth_client reuse a
      // usable/refreshable token when present and otherwise build an auth URL. Client
      // registration is usually already done at create/put; concurrent Connect races are
      // harmless (last saveClient wins; rare orphan AS registration).
      const authStatus = await deps.resolveMcpServerStore(c).authorize({
        tenant_id: requestContext.tenant_id,
        name,
        userRef,
        ...(returnTo !== undefined ? { returnTo } : {}),
      });
      return c.json(authStatus, 200);
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      if (error instanceof McpServerNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (error instanceof McpConnectionError) {
        deps.logger.warn(`MCP authorize failed for "${name}"`, extractErrorLogFields(error));
        if (error.statusCode === 400) {
          return c.json({ error: { message: error.message } }, 400);
        }
        if (error.statusCode === 422) {
          return c.json({ error: { message: error.message } }, 422);
        }
        if (error.statusCode === 424) {
          return c.json({ error: { message: error.message } }, 424);
        }
        return c.json({ error: { message: error.message } }, 500);
      }
      deps.logger.error(`MCP authorize unexpected failure for "${name}"`, extractErrorLogFields(error));
      return c.json({ error: { message: 'Internal server error' } }, 500);
    }
  };

  const listToolsHandler: RouteHandler<typeof listMcpServerToolsRoute> = async c => {
    const { name } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const userRef = requestContext.subject.id;
    // Same url + header resolution as turn execution (store Bearer, DCR, or static headers).
    const connection = await getMcpConnection({
      tenant_id: requestContext.tenant_id,
      name,
      store: deps.resolveMcpServerStore(c),
      userRef,
    });
    if (connection === undefined) {
      return c.json({ error: { message: `MCP server not found: ${name}` } }, 404);
    }
    const remote = new RemoteMCP({
      id: name,
      name,
      url: connection.url,
      headers: connection.headers,
      requestTimeoutMs: configuration.MCP_REQUEST_TIMEOUT_MS,
      connectTimeoutMs: configuration.MCP_CONNECT_TIMEOUT_MS,
      refuseRedirects: connection.first_party,
      logger: deps.logger,
      signal: c.req.raw.signal,
    });
    try {
      const response = await remote.listTools();
      if (isAuthRequired(response)) {
        return c.json({ error: { message: `MCP server "${name}" requires authentication` } }, 422);
      }
      const data = response.result.tools.map(tool => omitUndefinedEntries({ ...tool }));
      return c.json({ data }, 200);
    } catch (error) {
      if (error instanceof McpConnectionError) {
        deps.logger.warn(`MCP tools/list failed for "${name}"`, extractErrorLogFields(error));
        if (error.statusCode === 401) {
          return c.json({ error: { message: error.message } }, 422);
        }
        return c.json({ error: { message: error.message } }, 502);
      }
      throw error;
    }
  };

  const memoryCheckHandler: RouteHandler<typeof memoryCheckMcpServerRoute> = async c => {
    const { name } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const userRef = requestContext.subject.id;
    const record = await deps.resolveMcpServerStore(c).getServer({ tenant_id: requestContext.tenant_id, name });
    if (!record) {
      return c.json({ error: { message: `MCP server not found: ${name}` } }, 404);
    }
    // Read-only: the stored manifest is checked as saved, so a user who fixed their provider can
    // re-check without toggling the flag off and on.
    const outcome = await checkMemoryProvider({
      manifest: record.manifest,
      stored: record,
      mcpServerStore: deps.resolveMcpServerStore(c),
      tokenStore: deps.tokenStore,
      tenant_id: requestContext.tenant_id,
      userRef,
    });
    if (!outcome.ok) {
      deps.logger.warn(`Memory provider check failed for "${name}"`, {
        code: outcome.code,
        reason: outcome.reason,
        ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
      });
    }
    return c.json({ data: toMemoryProviderCheckResult(outcome) }, 200);
  };

  const deleteAuthorizationHandler: RouteHandler<typeof deleteAuthorizationMcpServerRoute> = async c => {
    const { name } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const userRef = requestContext.subject.id;
    try {
      const record = await deps.resolveMcpServerStore(c).getServer({
        tenant_id: requestContext.tenant_id,
        name,
      });
      if (!record) {
        return c.json({ error: { message: `MCP server not found: ${name}` } }, 404);
      }
      await deps.resolveMcpServerStore(c).deleteAuthorization({
        tenant_id: requestContext.tenant_id,
        name,
        userRef,
      });
      return c.json(
        {
          data: await toConfiguredMcpServer({
            store: deps.resolveMcpServerStore(c),
            record,
            userRef,
          }),
        },
        200,
      );
    } catch (error) {
      if (error instanceof McpServerNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      throw error;
    }
  };

  const listToolGrantsHandler: RouteHandler<typeof listMcpToolGrantsRoute> = async c => {
    const { name } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.resolveMcpServerStore(c).getServer({ tenant_id: requestContext.tenant_id, name });
    if (!record) {
      return c.json({ error: { message: `MCP server not found: ${name}` } }, 404);
    }
    const data = await deps.toolGrantStore.listToolGrants({
      tenant_id: requestContext.tenant_id,
      created_by: requestContext.subject.id,
      mcp_server_name: name,
      connector: connectorIdentity(record),
    });
    return c.json({ data }, 200);
  };

  const deleteToolGrantHandler: RouteHandler<typeof deleteMcpToolGrantRoute> = async c => {
    const { name, tool_name } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.resolveMcpServerStore(c).getServer({ tenant_id: requestContext.tenant_id, name });
    if (!record) {
      return c.json({ error: { message: `MCP server not found: ${name}` } }, 404);
    }
    await deps.toolGrantStore.revokeToolGrant({
      tenant_id: requestContext.tenant_id,
      created_by: requestContext.subject.id,
      mcp_server_name: name,
      tool_name,
    });
    return c.json({}, 200);
  };

  const getAvailableHandler: RouteHandler<typeof getAvailableMcpServerRoute> = async c => {
    const { name } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.resolveMcpServerStore(c).getServer({
      tenant_id: requestContext.tenant_id,
      name,
    });
    // The memory provider is host-owned and never offered to chat surfaces (see the filter in
    // listAvailableMcpServersRoute below); treating it as not-found here keeps a direct lookup by
    // name consistent with what the list endpoint would ever return.
    if (!record || (record.manifest.type === 'remote' && record.manifest.memory_provider === true)) {
      return c.json({ error: { message: `MCP server not found: ${name}` } }, 404);
    }
    return c.json(
      {
        data: await resolveAvailableMcpServer({
          store: deps.resolveMcpServerStore(c),
          record,
          userRef: requestContext.subject.id,
        }),
      },
      200,
    );
  };

  const router = new OpenAPIHono();
  router.openapi(listAvailableMcpServersRoute, async c => {
    const requestContext = deps.resolveRequestContext(c);
    const userRef = requestContext.subject.id;
    const stored = await deps.resolveMcpServerStore(c).listServers({
      tenant_id: requestContext.tenant_id,
      names: undefined,
    });
    // The memory provider is host-owned: it recalls before every model call and retains every
    // completed turn by itself, and the turn resolver hands the model only its read tools. There
    // is nothing left for a user to gain by attaching it to a chat, so it is not offered as a
    // choice rather than being offered and expected to be left alone. Filtered here, in the chat
    // projection, rather than in a picker component: this shape is what every chat-facing client
    // reads, and it deliberately does not carry `memory_provider`, so a client could not apply
    // this rule for itself without a second call to the settings list. The settings projection is
    // untouched, so the connector stays fully visible where it is configured. An agent or session
    // that already mounts it keeps working: this changes what is offered, never what is stored.
    const records = stored.filter(
      record => !(record.manifest.type === 'remote' && record.manifest.memory_provider === true),
    );
    const statuses = await deps.resolveMcpServerStore(c).resolveAuthStatuses({
      records,
      userRef,
    });
    const data: AvailableMcpServer[] = records.map(record =>
      toAvailableMcpServer({
        record,
        authStatus: statuses.get(record.name) ?? { status: 'auth_required' },
      }),
    );
    return c.json({ data }, 200);
  });
  router.openapi(listMcpServerToolsRoute, listToolsHandler);
  router.openapi(listMcpToolGrantsRoute, listToolGrantsHandler);
  router.openapi(deleteMcpToolGrantRoute, deleteToolGrantHandler);
  router.openapi(authorizeMcpServerRoute, authorizeHandler);
  router.openapi(memoryCheckMcpServerRoute, memoryCheckHandler);
  router.openapi(deleteAuthorizationMcpServerRoute, deleteAuthorizationHandler);
  router.openapi(getAvailableMcpServerRoute, getAvailableHandler);
  return router;
}
