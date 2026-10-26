/**
 * Email account API under /api/v1/user/settings/email: the Settings Email card's endpoints. What each call
 * does is shared with Calendar (see connectorAccountHandlers.ts); this file holds Email's own status shape.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { PublicMailAccount } from '@truefoundry/trueforge-core/core/email/mailConnector/accountFile';
import {
  EMAIL_PROVIDER_PRESETS,
  mailProviderKeyForHosts,
} from '@truefoundry/trueforge-core/core/email/mailConnector/presets';
import type { Logger } from 'winston';
import configuration, { mailMcpUrlFromAccountUrl } from '../config';
import type { IMcpServerStore } from '../db/mcpServerStore';
import { emailAccountRoutes } from '../routes/emailAccountRoutes';
import { connectionStateOf } from '../runtime/connectorAccount';
import {
  getMailAccountState,
  removeMailAccount,
  saveMailAccount,
  syncMailConnectorWithAccount,
} from '../runtime/mailAccount';
import type { EmailAccountStatus, SaveEmailAccountRequest } from '../schemas/emailAccount';
import { createConnectorAccountHandlers } from './connectorAccountHandlers';
import { requireJsonOrSameOrigin } from './crossSite';
import { TENANT_ID } from './sessions';

export const EMAIL_SETTINGS_BASE_PATH = '/api/v1/user/settings/email';

interface EmailAccountRouterDeps {
  logger: Logger;
  /** Replaceable so tests never reach a real sidecar. */
  fetchImpl: typeof fetch | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer'>;
}

const DEFAULT_PROVIDER_KEY = 'gmail';

function providerTable(): EmailAccountStatus['providers'] {
  return EMAIL_PROVIDER_PRESETS.map(preset => ({ ...preset }));
}

export function createEmailAccountRouter(deps: EmailAccountRouterDeps) {
  const clientDeps = () => ({
    accountUrl: configuration.MAIL_EMAIL_ACCOUNT_URL,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
  });
  const handlers = createConnectorAccountHandlers<PublicMailAccount, SaveEmailAccountRequest, EmailAccountStatus>({
    isAvailable: () => configuration.MAIL_EMAIL_ACCOUNT_URL !== undefined,
    unavailableBody: () => ({
      available: false,
      state: 'not_connected',
      address: null,
      provider_key: DEFAULT_PROVIDER_KEY,
      providers: providerTable(),
    }),
    statusBody: state => ({
      available: true,
      state: connectionStateOf(state),
      address: state.account?.address ?? null,
      provider_key: state.account === null ? DEFAULT_PROVIDER_KEY : mailProviderKeyForHosts(state.account),
      providers: providerTable(),
    }),
    readState: () => getMailAccountState(clientDeps()),
    save: request =>
      saveMailAccount(clientDeps(), {
        provider_key: request.provider_key,
        address: request.address,
        password: request.password,
        imap_host: request.imap_host,
        imap_port: request.imap_port,
        smtp_host: request.smtp_host,
        smtp_port: request.smtp_port,
      }),
    remove: () => removeMailAccount(clientDeps()),
    sync: state =>
      syncMailConnectorWithAccount({
        state,
        mcpUrl: configuration.MAIL_EMAIL_MCP_URL ?? mailMcpUrlFromAccountUrl(configuration.MAIL_EMAIL_ACCOUNT_URL),
        policyPath: configuration.MAIL_POLICY_FILE,
        mcpServerStore: deps.mcpServerStore,
        tenant_id: TENANT_ID,
        logger: deps.logger,
      }),
  });

  const router = new OpenAPIHono();
  router.use('/', requireJsonOrSameOrigin());
  router.openapi(emailAccountRoutes.status, async c => {
    const answer = await handlers.status();
    return answer.status === 200 ? c.json(answer.body, 200) : c.json(answer.body, 502);
  });
  router.openapi(emailAccountRoutes.save, async c => {
    const answer = await handlers.save(c.req.valid('json'));
    if (answer.status === 201) {
      return c.json(answer.body, 201);
    }
    return answer.status === 400 ? c.json(answer.body, 400) : c.json(answer.body, 502);
  });
  router.openapi(emailAccountRoutes.remove, async c => {
    const answer = await handlers.remove();
    return answer.status === 200 ? c.json(answer.body, 200) : c.json(answer.body, 502);
  });
  return router;
}
