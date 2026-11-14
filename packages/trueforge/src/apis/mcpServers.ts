import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { extractErrorLogFields, isAuthRequired, McpConnectionError, RemoteMCP } from '@truefoundry/trueforge-core/core';
import { HOME_ASSISTANT_SERVER_NAME } from '@truefoundry/trueforge-core/core/homeassistant/toolContract';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
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
import { connectorGrantBinding } from '../mcp/connectorGrantBinding';
import { isFirstPartyOrigin } from '../mcp/firstParty';
import { checkHomeAssistant, homeAssistantUrlProblem, type HomeAssistantProbeClient } from '../mcp/homeAssistant';
import {
  authorizeMcpServerRoute,
  createMcpServerRoute,
  deleteAuthorizationMcpServerRoute,
  deleteMcpServerRoute,
  deleteMcpToolGrantRoute,
  getAvailableMcpServerRoute,
  getMcpServerRoute,
  homeAssistantCheckMcpServerRoute,
  listAvailableMcpServersRoute,
  listMcpServersRoute,
  listMcpServerToolsRoute,
  listMcpToolGrantsRoute,
  putMcpServerRoute,
} from '../routes/mcpServerRoutes';
import { remoteUrlProblem } from '../runtime/remoteAddress';
import { getMcpConnection, RemoteAddressRefusedError } from '../runtime/sessionResources';
import type {
  AvailableMcpServer,
  ConfiguredMcpServer,
  CreateMcpServerRequest,
  McpAuthStatus,
  McpServerManifest,
  UpdateMcpServerRequest,
} from '../schemas/mcpServer';
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

/**
 * Only one configured server may be the search provider: the user's silent searches go through
 * exactly one connector. `excludeName` skips the row being written itself, so re-saving the holder
 * is not a conflict with itself. Returns the first other holder found, or undefined.
 */
async function findOtherSearchProvider({
  mcpServerStore,
  tenant_id,
  excludeName,
}: {
  mcpServerStore: IMcpServerStore;
  tenant_id: string;
  excludeName: string;
}): Promise<McpServerRecord | undefined> {
  const servers = await mcpServerStore.listServers({ tenant_id, names: undefined });
  return servers.find(
    server =>
      server.name !== excludeName && server.manifest.type === 'remote' && server.manifest.search_provider === true,
  );
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
    ...(params.record.manifest.type === 'remote' && params.record.manifest.search_provider === true
      ? { search_provider: true }
      : {}),
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

/**
 * The reason a remote connector address may not be used, or undefined when it may. An origin on
 * the operator's own list is the operator's own service and is not second-guessed; every other
 * remote address is resolved and judged by the address check (see runtime/remoteAddress) before
 * anything dials it or writes it. A host that does not resolve is not refused here: it connects
 * nowhere, the connection attempt reports its own failure, and the address is judged again on
 * the next check if the name starts resolving. The wording is the same wherever the refusal is
 * served, so the person hears one explanation.
 */
async function remoteAddressRefusal({ url }: { url: string }): Promise<string | undefined> {
  if (isFirstPartyOrigin({ url, origins: configuration.FIRST_PARTY_MCP_ORIGINS })) {
    return undefined;
  }
  const problem = await remoteUrlProblem({ url });
  switch (problem) {
    case null:
    case 'unresolved':
      return undefined;
    case 'blocked':
      return 'That address is on this computer, so the server cannot connect to it. Enter an address on your home network or the internet instead.';
    case 'invalid':
      return 'That address is not one the server can connect to. Enter the full address, starting with http:// or https://, without a name and password in it.';
  }
}

export function createSettingsMcpServersRouter<TTransaction>(
  deps: McpServersRouterDeps<TTransaction> & { mcpCatalog: McpCatalog },
) {
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

    if (incomingManifest.type === 'remote' && incomingManifest.search_provider === true) {
      const conflict = await findOtherSearchProvider({
        mcpServerStore: deps.resolveMcpServerStore(c),
        tenant_id: requestContext.tenant_id,
        excludeName: incomingManifest.name,
      });
      if (conflict !== undefined) {
        return c.json({ error: { message: `search provider already set on ${conflict.name}; disable it first` } }, 409);
      }
    }

    // The address check comes before DCR and before the write: registration dials the address,
    // so a refused address is neither dialed nor saved.
    if (incomingManifest.type === 'remote') {
      const refusal = await remoteAddressRefusal({ url: incomingManifest.url });
      if (refusal !== undefined) {
        return c.json({ error: { message: refusal } }, 400);
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

    // The Home Assistant preset's address rule, enforced on the resolved manifest: https, or
    // http only on a private or loopback address, at the endpoint the preset builds.
    if (manifest.type === 'remote' && manifest.name === HOME_ASSISTANT_SERVER_NAME) {
      const problem = homeAssistantUrlProblem(manifest.url);
      if (problem !== null) {
        return c.json({ error: { message: problem } }, 400);
      }
    }

    try {
      const record = await deps.withTransaction(async transaction => {
        const saved = await deps.resolveMcpServerStore(c).createServer(
          {
            tenant_id: requestContext.tenant_id,
            name: manifest.name,
            manifest,
            first_party: false,
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

    if (incomingManifest.type === 'remote' && incomingManifest.name === HOME_ASSISTANT_SERVER_NAME) {
      const problem = homeAssistantUrlProblem(incomingManifest.url);
      if (problem !== null) {
        return c.json({ error: { message: problem } }, 400);
      }
    }

    if (incomingManifest.type === 'remote' && incomingManifest.search_provider === true) {
      const conflict = await findOtherSearchProvider({
        mcpServerStore: deps.resolveMcpServerStore(c),
        tenant_id: requestContext.tenant_id,
        excludeName: incomingManifest.name,
      });
      if (conflict !== undefined) {
        return c.json({ error: { message: `search provider already set on ${conflict.name}; disable it first` } }, 409);
      }
    }

    // The address check comes before the write, so a refused address is never saved.
    if (incomingManifest.type === 'remote') {
      const refusal = await remoteAddressRefusal({ url: incomingManifest.url });
      if (refusal !== undefined) {
        return c.json({ error: { message: refusal } }, 400);
      }
    }

    try {
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
            first_party: false,
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
        if (existing !== undefined && connectorGrantBinding(existing) !== connectorGrantBinding(saved)) {
          // A new address or a new way to sign in is a different setup: Always allow was granted to the old one's
          // tools, and those grants would never match again, so they go rather than stay listed.
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

    // The authorize flow dials the stored address for discovery, so the address check gates it
    // like any other connection. A missing record falls through to the store, which answers
    // with its own not-found error.
    const record = await deps.resolveMcpServerStore(c).getServer({ tenant_id: requestContext.tenant_id, name });
    if (record?.manifest.type === 'remote') {
      const refusal = await remoteAddressRefusal({ url: record.manifest.url });
      if (refusal !== undefined) {
        return c.json({ error: { message: refusal } }, 422);
      }
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
    // The address check inside getMcpConnection refuses a stored address that resolves inward;
    // serve that refusal as the client's answer instead of letting it escape as a 500.
    let connection: Awaited<ReturnType<typeof getMcpConnection>>;
    try {
      connection = await getMcpConnection({
        tenant_id: requestContext.tenant_id,
        name,
        store: deps.resolveMcpServerStore(c),
        userRef,
      });
    } catch (error) {
      if (error instanceof RemoteAddressRefusedError) {
        return c.json({ error: { message: error.message } }, 422);
      }
      throw error;
    }
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
      maxResponseBytes: configuration.MCP_TOOL_CALL_MAX_RESPONSE_BYTES,
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

  const homeAssistantCheckHandler: RouteHandler<typeof homeAssistantCheckMcpServerRoute> = async c => {
    const { name } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const userRef = requestContext.subject.id;
    // Same url + header resolution as turn execution, so the check dials with the saved token.
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
      maxResponseBytes: configuration.MCP_TOOL_CALL_MAX_RESPONSE_BYTES,
      refuseRedirects: connection.first_party,
      logger: deps.logger,
      signal: c.req.raw.signal,
    });
    const probe: HomeAssistantProbeClient = {
      listTools: async () => {
        const response = await remote.listTools();
        return isAuthRequired(response) ? { authRequired: true } : { tools: response.result.tools };
      },
      callTool: async ({ name: toolName, arguments: args }) => {
        const response = await remote.callTool({ name: toolName, arguments: args });
        if (isAuthRequired(response)) {
          return { authRequired: true };
        }
        const texts = response.result.content.flatMap(part => (part.type === 'text' ? [part.text] : []));
        return { texts };
      },
    };
    const data = await checkHomeAssistant(probe);
    if (data.status === 'failed') {
      // The code and the plain reason only: never the headers the check dialed with.
      deps.logger.warn(`Home Assistant check failed for "${name}"`, { code: data.code, reason: data.reason });
    }
    return c.json({ data }, 200);
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
    if (!record) {
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
    const records = await deps.resolveMcpServerStore(c).listServers({
      tenant_id: requestContext.tenant_id,
      names: undefined,
    });
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
  router.openapi(homeAssistantCheckMcpServerRoute, homeAssistantCheckHandler);
  router.openapi(deleteAuthorizationMcpServerRoute, deleteAuthorizationHandler);
  router.openapi(getAvailableMcpServerRoute, getAvailableHandler);
  return router;
}
