/**
 * Email account API under /api/v1/user/settings/email: the Settings Email card's endpoints.
 * Browser session only (mounted behind the UI-session middleware, like Google's), so no agent
 * or API token can read or change the account. The app password passes through the save call to
 * the sidecar's account agent and is never stored here, never logged, and never returned; the
 * responses are built only from the account's public view.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import {
  EMAIL_PROVIDER_PRESETS,
  mailProviderKeyForHosts,
} from '@truefoundry/trueforge-core/core/email/mailConnector/presets';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import configuration from '../config';
import type { IMcpServerStore } from '../db/mcpServerStore';
import {
  getEmailAccountStatusRoute,
  removeEmailAccountRoute,
  saveEmailAccountRoute,
} from '../routes/emailAccountRoutes';
import {
  getMailAccountState,
  MailAccountError,
  removeMailAccount,
  saveMailAccount,
  syncMailConnectorWithAccount,
  type MailAccountState,
} from '../runtime/mailAccount';
import type { EmailAccountStatus } from '../schemas/emailAccount';
import { requireJsonOrSameOrigin } from './crossSite';
import { TENANT_ID } from './sessions';

export const EMAIL_SETTINGS_BASE_PATH = '/api/v1/user/settings/email';

interface EmailAccountRouterDeps {
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
  /** Replaceable so tests never reach a real sidecar. */
  fetchImpl: typeof fetch | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer'>;
}

function statusBody(state: MailAccountState): EmailAccountStatus {
  return {
    available: true,
    state: !state.connected ? 'not_connected' : state.sign_in === 'refused' ? 'sign_in_stopped' : 'connected',
    address: state.account?.address ?? null,
    provider_key: state.account === null ? 'gmail' : mailProviderKeyForHosts(state.account),
    providers: EMAIL_PROVIDER_PRESETS.map(preset => ({ ...preset })),
  };
}

function unavailableBody(): EmailAccountStatus {
  return {
    available: false,
    state: 'not_connected',
    address: null,
    provider_key: 'gmail',
    providers: EMAIL_PROVIDER_PRESETS.map(preset => ({ ...preset })),
  };
}

export function createEmailAccountRouter(deps: EmailAccountRouterDeps) {
  const clientDeps = () => ({
    accountUrl: configuration.MAIL_EMAIL_ACCOUNT_URL,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
  });
  const effectiveMcpUrl = () => configuration.MAIL_SIDECAR_MCP_URL;

  const syncConnector = async (state: MailAccountState) => {
    await syncMailConnectorWithAccount({
      state,
      mcpUrl: effectiveMcpUrl(),
      policyPath: configuration.MAIL_POLICY_FILE,
      mcpServerStore: deps.mcpServerStore,
      tenant_id: TENANT_ID,
      logger: deps.logger,
    });
  };

  const statusHandler: RouteHandler<typeof getEmailAccountStatusRoute> = async c => {
    if (configuration.MAIL_EMAIL_ACCOUNT_URL === undefined) {
      return c.json({ data: unavailableBody() }, 200);
    }
    try {
      return c.json({ data: statusBody(await getMailAccountState(clientDeps())) }, 200);
    } catch (caught) {
      if (caught instanceof MailAccountError) {
        // A status read can only fail one way: the connector could not be reached.
        return c.json({ error: { message: caught.message, type: caught.failure } }, 502);
      }
      throw caught;
    }
  };

  const saveHandler: RouteHandler<typeof saveEmailAccountRoute> = async c => {
    // The account is instance-wide and the router sits behind the browser-session middleware;
    // resolving the caller is the owner check, the same pattern as the other settings routers.
    deps.resolveRequestContext(c);
    const body = c.req.valid('json');
    try {
      const state = await saveMailAccount(clientDeps(), {
        provider_key: body.provider_key,
        address: body.address,
        password: body.password,
        imap_host: body.imap_host,
        imap_port: body.imap_port,
        smtp_host: body.smtp_host,
        smtp_port: body.smtp_port,
      });
      await syncConnector(state);
      return c.json({ data: statusBody(state) }, 201);
    } catch (caught) {
      if (caught instanceof MailAccountError) {
        return caught.failure === 'connector_unreachable'
          ? c.json({ error: { message: caught.message, type: caught.failure } }, 502)
          : c.json({ error: { message: caught.message, type: caught.failure } }, 400);
      }
      throw caught;
    }
  };

  const removeHandler: RouteHandler<typeof removeEmailAccountRoute> = async c => {
    deps.resolveRequestContext(c);
    try {
      const state = await removeMailAccount(clientDeps());
      await syncConnector(state);
      return c.json({ data: statusBody(state) }, 200);
    } catch (caught) {
      if (caught instanceof MailAccountError) {
        // A removal can only fail one way: the connector could not be reached.
        return c.json({ error: { message: caught.message, type: caught.failure } }, 502);
      }
      throw caught;
    }
  };

  const router = new OpenAPIHono();
  router.use('/', requireJsonOrSameOrigin());
  router.openapi(getEmailAccountStatusRoute, statusHandler);
  router.openapi(saveEmailAccountRoute, saveHandler);
  router.openapi(removeEmailAccountRoute, removeHandler);
  return router;
}
