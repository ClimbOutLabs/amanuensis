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
import configuration from '../config';
import type { IMcpServerStore } from '../db/mcpServerStore';
import { emailAccountRoutes } from '../routes/emailAccountRoutes';
import { connectionStateForSignIn, connectionStateOf } from '../runtime/connectorAccount';
import {
  getMailAccountState,
  removeMailAccount,
  saveMailAccount,
  setMailDefaultAccount,
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
    secret: configuration.MAIL_EMAIL_ACCOUNT_SECRET,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
  });
  const handlers = createConnectorAccountHandlers<PublicMailAccount, SaveEmailAccountRequest, EmailAccountStatus>({
    isAvailable: () =>
      configuration.MAIL_EMAIL_ACCOUNT_URL !== undefined && configuration.MAIL_EMAIL_ACCOUNT_SECRET !== undefined,
    unavailableBody: () => ({
      available: false,
      state: 'not_connected',
      address: null,
      provider_key: DEFAULT_PROVIDER_KEY,
      accounts: [],
      default_address: null,
      providers: providerTable(),
    }),
    statusBody: state => ({
      available: true,
      state: connectionStateOf(state),
      address: state.account?.address ?? null,
      provider_key: state.account === null ? DEFAULT_PROVIDER_KEY : mailProviderKeyForHosts(state.account),
      accounts: state.accounts.map(entry => ({
        address: entry.account.address,
        provider_key: mailProviderKeyForHosts(entry.account),
        state: connectionStateForSignIn(entry.sign_in),
        is_default: entry.account.address === state.default_key,
        imap_host: entry.account.imap_host,
        imap_port: entry.account.imap_port,
        imap_mode: entry.account.imap_mode,
        smtp_host: entry.account.smtp_host,
        smtp_port: entry.account.smtp_port,
        smtp_mode: entry.account.smtp_mode,
      })),
      default_address: state.default_key,
      providers: providerTable(),
    }),
    readState: options => getMailAccountState(clientDeps(), options),
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
    remove: key => removeMailAccount(clientDeps(), key),
    setDefault: key => setMailDefaultAccount(clientDeps(), key),
    sync: state =>
      syncMailConnectorWithAccount({
        state,
        mcpUrl: configuration.MAIL_SIDECAR_MCP_URL,
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
    const answer = await handlers.remove(c.req.valid('json').address);
    return answer.status === 200 ? c.json(answer.body, 200) : c.json(answer.body, 502);
  });
  router.openapi(emailAccountRoutes.setDefault, async c => {
    const answer = await handlers.setDefault(c.req.valid('json').address);
    if (answer.status === 200) {
      return c.json(answer.body, 200);
    }
    return answer.status === 400 ? c.json(answer.body, 400) : c.json(answer.body, 502);
  });
  return router;
}
