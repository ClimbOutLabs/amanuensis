import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import { CALDAV_SERVER_NAME } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import type { Logger } from 'winston';

import type { IMcpServerStore } from '../db/mcpServerStore';

/** Plain words: this is the description a person reads on the Connectors page. */
const CALENDAR_CONNECTOR_DESCRIPTION = 'Reads and changes the calendars connected to this instance.';

/**
 * Registers the Calendar connector at the calendar sidecar's endpoint. Runs at every boot, so the stored
 * endpoint matches the configuration. The operator configured this endpoint, so the connector is first-party.
 * Without an endpoint nothing is written.
 */
export async function registerCalendarConnector({
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
    name: CALDAV_SERVER_NAME,
    manifest: { type: 'remote', name: CALDAV_SERVER_NAME, url, description: CALENDAR_CONNECTOR_DESCRIPTION },
    first_party: true,
  });
  return 'registered';
}

/** Boot step: a failure is logged and never keeps the server from starting. */
export async function registerCalendarConnectorAtBoot({
  logger,
  ...register
}: {
  url: string | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer'>;
  tenant_id: string;
  logger: Pick<Logger, 'warn'>;
}): Promise<void> {
  try {
    await registerCalendarConnector(register);
  } catch (error) {
    logger.warn('Calendar connector could not be registered', extractErrorLogFields(error));
  }
}

/**
 * Removes the Calendar connector's registration, when the saved account is removed. A connector left
 * registered with no account behind it would offer calendar tools that can only fail.
 */
export async function unregisterCalendarConnector({
  mcpServerStore,
  tenant_id,
}: {
  mcpServerStore: Pick<IMcpServerStore, 'deleteServer'>;
  tenant_id: string;
}): Promise<void> {
  await mcpServerStore.deleteServer({ tenant_id, name: CALDAV_SERVER_NAME });
}
