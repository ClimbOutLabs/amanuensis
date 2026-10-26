import configuration from '../config';
import { isHostSidecar, isReservedConnectorName } from './firstParty';

/**
 * Whether a connector record is the host's own Email or Calendar sidecar, judged by the addresses the host
 * was set up with. This is the one rule for "the host's own": the name alone never counts.
 */
export function isHostOwnConnector({ name, url }: { name: string; url: string }): boolean {
  return isHostSidecar({
    name,
    url,
    mailUrl: configuration.MAIL_SIDECAR_MCP_URL,
    calendarUrl: configuration.CALENDAR_SIDECAR_MCP_URL,
  });
}

/**
 * The names of the connectors that count as set up. A reserved name counts only for the host's own sidecar, so
 * a record that merely carries the name is never attached by default and never treated as the host's own.
 */
export function setUpConnectorNamesOf(records: readonly { name: string; manifest: { url: string } }[]): string[] {
  return records
    .filter(
      record =>
        !isReservedConnectorName(record.name) || isHostOwnConnector({ name: record.name, url: record.manifest.url }),
    )
    .map(record => record.name);
}
