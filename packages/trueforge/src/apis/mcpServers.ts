import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import {
  declaredSearchProviderTools,
  extractErrorLogFields,
  isAuthRequired,
  McpConnectionError,
  RemoteMCP,
  type RemoteMcpHeaders,
} from '@truefoundry/trueforge-core/core';
import {
  HOME_ASSISTANT_SERVER_NAME,
  homeAssistantDeclaredChangeTools,
} from '@truefoundry/trueforge-core/core/homeassistant/toolContract';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import { safeReturnTo } from '../auth/safeReturnTo';
import type { McpCatalog, SearchDeclaration } from '../catalog/McpCatalog';
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
import {
  getMcpConnection,
  RemoteAddressRefusedError,
  resolveManifestRequestHeaders,
} from '../runtime/sessionResources';
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
 * The search declaration is captured when the person designates the provider, from the
 * server's own tool list or from the declaration its shipped preset carries: whatever the
 * request carried is replaced, so a client cannot widen what runs without asking. Only the
 * web search provider carries a declaration. Both tool lists are stored even when empty, so
 * a record that carries the split is told apart from one written before the split existed.
 */
function withSearchDeclaration({
  manifest,
  declaration,
}: {
  manifest: McpServerManifest;
  declaration: SearchDeclaration | undefined;
}): McpServerManifest {
  if (manifest.type !== 'remote') {
    return manifest;
  }
  if (manifest.search_provider !== true || declaration === undefined) {
    return {
      ...manifest,
      search_tools: undefined,
      page_read_tools: undefined,
      search_plumbing_fields: undefined,
      search_in_process: undefined,
    };
  }
  return {
    ...manifest,
    search_tools: [...declaration.search_tools],
    page_read_tools: [...declaration.page_read_tools],
    search_plumbing_fields: declaration.plumbing_fields.length > 0 ? [...declaration.plumbing_fields] : undefined,
    search_in_process: declaration.in_process ? true : undefined,
  };
}

/** The declaration a stored record already carries, when it was designated and holds the split. */
function storedSearchDeclaration(manifest: McpServerManifest | undefined): SearchDeclaration | undefined {
  if (manifest === undefined || manifest.type !== 'remote' || manifest.search_provider !== true) {
    return undefined;
  }
  if (manifest.page_read_tools === undefined) {
    return undefined;
  }
  return {
    search_tools: manifest.search_tools ?? [],
    page_read_tools: manifest.page_read_tools,
    plumbing_fields: manifest.search_plumbing_fields ?? [],
    in_process: manifest.search_in_process === true,
  };
}

/**
 * The declaration a save can settle without dialing: the stored one, when this save keeps the
 * same designated connector at the same address, or the one the shipped preset at the address
 * carries. Undefined when neither speaks, and the caller must read the server's own tool list.
 */
function settledSearchDeclaration({
  manifest,
  stored,
  mcpCatalog,
}: {
  manifest: McpServerManifest;
  stored: McpServerManifest | undefined;
  mcpCatalog: McpCatalog;
}): SearchDeclaration | undefined {
  if (manifest.type !== 'remote' || manifest.search_provider !== true) {
    return undefined;
  }
  if (stored !== undefined && stored.type === 'remote' && stored.url === manifest.url) {
    const carried = storedSearchDeclaration(stored);
    if (carried !== undefined) {
      return carried;
    }
  }
  return mcpCatalog.searchDeclarationForUrl(manifest.url);
}

/**
 * `declared_change_tools` is the server's own declaration, captured at connect time from its
 * tool list: whatever the request carried is replaced. An update of the same connector at the
 * same address keeps the stored declaration; any other write starts with none, until the next
 * connect check captures the server's list again.
 */
function withStoredDeclaredChangeTools({
  manifest,
  existing,
}: {
  manifest: McpServerManifest;
  existing: McpServerManifest | undefined;
}): McpServerManifest {
  if (manifest.type !== 'remote') {
    return manifest;
  }
  const kept =
    existing !== undefined && existing.type === 'remote' && existing.url === manifest.url
      ? existing.declared_change_tools
      : undefined;
  return { ...manifest, declared_change_tools: kept };
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
  /**
   * The search declaration for a save that designates this connector, dialing the server when
   * neither the stored record nor a shipped preset settles it. The dial reads the server's own
   * tool list with the credential the row carries or will carry, and the declaration is read
   * from that list alone. A server whose tools cannot be read right now, or that asks for
   * sign-in first, is saved with no declaration at all: the designation stands, nothing runs
   * silently for it, and the declaration is captured the next time its tool list is read. The
   * one refusal is a shipped preset at the address carrying no search declaration, where the
   * catalog itself says the server is not a search provider. Runs outside the write
   * transaction, so its network I/O never holds a lock.
   */
  async function searchDeclarationForWrite({
    manifest,
    stored,
    mcpServerStore,
    tenant_id,
    userRef,
    signal,
  }: {
    manifest: McpServerManifest;
    stored: McpServerRecord | undefined;
    mcpServerStore: IMcpServerStore<TTransaction>;
    tenant_id: string;
    userRef: string;
    signal: AbortSignal;
  }): Promise<{ declaration: SearchDeclaration | undefined } | { rejection: string }> {
    if (manifest.type !== 'remote' || manifest.search_provider !== true) {
      return { declaration: undefined };
    }
    const settled = settledSearchDeclaration({ manifest, stored: stored?.manifest, mcpCatalog: deps.mcpCatalog });
    if (settled !== undefined) {
      return { declaration: settled };
    }
    if (deps.mcpCatalog.presetForUrl(manifest.url) !== undefined) {
      // A shipped preset stands at this address and carries no search declaration, so the
      // catalog itself says this server is not a search provider.
      return {
        rejection: 'That server does not offer search tools, so it cannot be the search provider.',
      };
    }
    let headers: RemoteMcpHeaders;
    if (stored !== undefined && stored.manifest.type === 'remote' && stored.manifest.url === manifest.url) {
      const connection = await getMcpConnection({ tenant_id, name: stored.name, store: mcpServerStore, userRef });
      headers = connection?.headers ?? resolveManifestRequestHeaders(manifest);
    } else {
      headers = resolveManifestRequestHeaders(manifest);
    }
    const remote = new RemoteMCP({
      id: manifest.name,
      name: manifest.name,
      url: manifest.url,
      headers,
      requestTimeoutMs: configuration.MCP_REQUEST_TIMEOUT_MS,
      connectTimeoutMs: configuration.MCP_CONNECT_TIMEOUT_MS,
      maxResponseBytes: configuration.MCP_TOOL_CALL_MAX_RESPONSE_BYTES,
      refuseRedirects: true,
      logger: deps.logger,
      signal,
    });
    try {
      const response = await remote.listTools();
      if (isAuthRequired(response)) {
        // The designation is saved with no declaration: the server's tools are captured when
        // they are next read, after the person has connected it.
        deps.logger.warn(
          `Search provider tool capture needs sign-in for "${manifest.name}"; saving without a declaration`,
        );
        return { declaration: undefined };
      }
      const declaration = declaredSearchProviderTools(response.result.tools);
      return { declaration: { ...declaration, plumbing_fields: [], in_process: false } };
    } catch (error) {
      // Same shape: the designation stands, no declaration is stored, and nothing runs
      // silently for this provider until a later read of its tool list captures one.
      deps.logger.warn(`Search provider tool capture failed for "${manifest.name}"; saving without a declaration`, {
        ...extractErrorLogFields(error),
      });
      return { declaration: undefined };
    }
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
      manifest = withStoredDeclaredChangeTools({
        manifest: resolveMcpServerManifestForWrite({
          incoming: incomingManifest,
          existing: undefined,
        }),
        existing: undefined,
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

    // The search declaration is settled here, after secret resolution and before the write:
    // captured from the server's own tool list when it can be read now, and left empty when
    // it cannot, so the stored designation never carries tool names nobody read off the server.
    if (manifest.type === 'remote' && manifest.search_provider === true) {
      const captured = await searchDeclarationForWrite({
        manifest,
        stored: undefined,
        mcpServerStore: deps.resolveMcpServerStore(c),
        tenant_id: requestContext.tenant_id,
        userRef: requestContext.subject.id,
        signal: c.req.raw.signal,
      });
      if ('rejection' in captured) {
        return c.json({ error: { message: captured.rejection } }, 422);
      }
      manifest = withSearchDeclaration({ manifest, declaration: captured.declaration });
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

    // The search declaration is captured in this unlocked pass: its dial must never run
    // inside the write lock. The capture is keyed to the address it read, and the transaction
    // below applies it only to a manifest still at that address.
    let searchCapture: { url: string; declaration: SearchDeclaration | undefined } | undefined;
    if (incomingManifest.type === 'remote' && incomingManifest.search_provider === true) {
      const stored = await deps
        .resolveMcpServerStore(c)
        .getServer({ tenant_id: requestContext.tenant_id, name: incomingManifest.name });
      const resolved = resolveMcpServerManifestForWrite({ incoming: incomingManifest, existing: stored?.manifest });
      const captured = await searchDeclarationForWrite({
        manifest: resolved,
        stored,
        mcpServerStore: deps.resolveMcpServerStore(c),
        tenant_id: requestContext.tenant_id,
        userRef,
        signal: c.req.raw.signal,
      });
      if ('rejection' in captured) {
        return c.json({ error: { message: captured.rejection } }, 422);
      }
      searchCapture = {
        url: resolved.type === 'remote' ? resolved.url : '',
        declaration: captured.declaration,
      };
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
        const resolved = resolveMcpServerManifestForWrite({
          incoming: incomingManifest,
          existing: existing?.manifest,
        });
        const declaration =
          searchCapture !== undefined && resolved.type === 'remote' && searchCapture.url === resolved.url
            ? searchCapture.declaration
            : settledSearchDeclaration({ manifest: resolved, stored: existing?.manifest, mcpCatalog: deps.mcpCatalog });
        const manifest = withStoredDeclaredChangeTools({
          manifest: withSearchDeclaration({ manifest: resolved, declaration }),
          existing: existing?.manifest,
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
      // Reading the tool list is a connect moment: a designated search provider whose record
      // carries no declaration yet, because its tools could not be read when it was
      // designated, gains the declaration from this very list, read off the server itself.
      try {
        const store = deps.resolveMcpServerStore(c);
        const record = await store.getServer({ tenant_id: requestContext.tenant_id, name });
        if (
          record !== undefined &&
          record.manifest.type === 'remote' &&
          record.manifest.search_provider === true &&
          record.manifest.page_read_tools === undefined &&
          record.manifest.url === connection.url
        ) {
          const declaration = declaredSearchProviderTools(response.result.tools);
          await store.upsertServer({
            tenant_id: requestContext.tenant_id,
            name: record.name,
            manifest: withSearchDeclaration({
              manifest: record.manifest,
              declaration: { ...declaration, plumbing_fields: [], in_process: false },
            }),
            first_party: record.first_party,
          });
        }
      } catch (error) {
        deps.logger.warn(`Search declaration could not be stored for "${name}"`, extractErrorLogFields(error));
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
    let listedTools: readonly { name: string; annotations?: { readOnlyHint?: boolean | undefined } | undefined }[] = [];
    const probe: HomeAssistantProbeClient = {
      listTools: async () => {
        const response = await remote.listTools();
        if (isAuthRequired(response)) {
          return { authRequired: true };
        }
        listedTools = response.result.tools;
        return { tools: response.result.tools };
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
    } else {
      // The check is the connect moment: capture the change tools the server itself declares
      // in its own tool list and store them on the connector record, where standing-grant
      // eligibility reads them. A failed capture leaves the stored declaration as it was.
      try {
        const store = deps.resolveMcpServerStore(c);
        const record = await store.getServer({ tenant_id: requestContext.tenant_id, name });
        if (record !== undefined && record.manifest.type === 'remote') {
          const declared = homeAssistantDeclaredChangeTools(listedTools);
          const stored = record.manifest.declared_change_tools ?? [];
          if (JSON.stringify(declared) !== JSON.stringify(stored)) {
            await store.upsertServer({
              tenant_id: requestContext.tenant_id,
              name: record.name,
              manifest: { ...record.manifest, declared_change_tools: declared },
              first_party: record.first_party,
            });
          }
        }
      } catch (error) {
        deps.logger.warn(`Home Assistant change tools could not be stored for "${name}"`, extractErrorLogFields(error));
      }
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
