import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import { MailAccountDirectory } from '@truefoundry/trueforge-core/core/email/mailConnector/MailConnectorSource';
import { MAIL_CONNECTOR_NAME } from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import type { Logger } from 'winston';

import type { IMcpServerStore } from '../db/mcpServerStore';
import { ensureAllowedRecipientsFile } from './mailAllowedRecipients';
import { runFirstFillInBackground } from './mailFirstFill';

/** Each chat's Email account names, read once per chat in this process and shared by its turns. */
export const mailAccountDirectory = new MailAccountDirectory();

/** Plain words: this is the description a person reads on the Connectors page. */
const MAIL_CONNECTOR_DESCRIPTION = 'Reads, drafts and sends email from the mail accounts set up for this instance.';

/**
 * Registers the Email connector at the mail sidecar's endpoint. Runs at every boot, so the stored endpoint
 * always matches the configuration. Without an endpoint the sidecar is not configured and nothing is written.
 * The sidecar is the operator's own, so it is first-party; the origin still has to be listed in the configuration.
 */
export async function registerMailConnector({
  url,
  mcpServerStore,
  tenant_id,
}: {
  url: string | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer'>;
  tenant_id: string;
}): Promise<'unconfigured' | 'registered'> {
  if (url === undefined) {
    return 'unconfigured';
  }
  await mcpServerStore.upsertServer({
    tenant_id,
    name: MAIL_CONNECTOR_NAME,
    manifest: { type: 'remote', name: MAIL_CONNECTOR_NAME, url, description: MAIL_CONNECTOR_DESCRIPTION },
    first_party: true,
  });
  return 'registered';
}

/**
 * Boot step for the send list: creates an empty list the first time, so the sidecar can start, and fills it
 * from Sent in the background. Never keeps the server from starting.
 */
export async function prepareMailPolicyAtBoot({
  url,
  policyPath,
  logger,
}: {
  url: string | undefined;
  policyPath: string | undefined;
  logger: Logger;
}): Promise<void> {
  if (url === undefined || policyPath === undefined) {
    return;
  }
  try {
    const created = await ensureAllowedRecipientsFile({ path: policyPath });
    if (created) {
      runFirstFillInBackground({ url, path: policyPath, logger });
    }
  } catch (error) {
    logger.warn('Email send list could not be prepared', extractErrorLogFields(error));
  }
}

/** Boot step: a failure is logged and never keeps the server from starting. */
export async function registerMailConnectorAtBoot({
  logger,
  ...register
}: {
  url: string | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer'>;
  tenant_id: string;
  logger: Pick<Logger, 'warn'>;
}): Promise<void> {
  try {
    await registerMailConnector(register);
  } catch (error) {
    logger.warn('Email connector could not be registered', extractErrorLogFields(error));
  }
}
