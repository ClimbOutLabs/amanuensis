/**
 * The connectors a person turned off for one chat, kept in the chat's session metadata.
 *
 * Search, email and calendar are on by default in every chat, so a chat's spec cannot say
 * "off": a connector missing from the spec means "never chosen", which now means on. The
 * off choice therefore lives here instead, one short flag per connector, and the turn setup
 * reads it back on every turn of the chat.
 */

import { CALDAV_SERVER_NAME } from '../calendar/caldav/toolContract.js';
import { MAIL_CONNECTOR_NAME } from '../email/mailConnector/toolContract.js';

/** The built-in sources on by default beside the search provider, each only when set up. */
export const DEFAULT_ON_SOURCE_CONNECTOR_NAMES: readonly string[] = [MAIL_CONNECTOR_NAME, CALDAV_SERVER_NAME];

/** Prefix of the per-connector flag keys. Metadata keys are capped at 32 characters. */
const CONNECTOR_OFF_KEY_PREFIX = 'connector_off_';

/** Exactly what connectorOffKey makes: the prefix and a 16-hex-digit digest. */
const CONNECTOR_OFF_KEY = /^connector_off_[0-9a-f]{16}$/;

/** Stable 64-bit digest of a name as 16 hex digits, so any name fits the metadata key cap. */
function nameDigest(name: string): string {
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (let index = 0; index < name.length; index += 1) {
    const unit = name.charCodeAt(index);
    high = Math.imul(high ^ unit, 0x01000193);
    low = Math.imul(low ^ unit, 0x85ebca6b) + high;
  }
  return [high, low].map(part => (part >>> 0).toString(16).padStart(8, '0')).join('');
}

/** The metadata key whose presence means this connector is turned off for the chat. */
export function connectorOffKey(name: string): string {
  return `${CONNECTOR_OFF_KEY_PREFIX}${nameDigest(name)}`;
}

/** The off keys of a chat, from its session metadata. No flag means the default, which is on. */
export function readTurnedOffConnectorKeys(metadata: Record<string, string> | null | undefined): string[] {
  if (metadata == null) {
    return [];
  }
  return Object.keys(metadata).filter(key => key.startsWith(CONNECTOR_OFF_KEY_PREFIX));
}

/**
 * The session metadata with the chat's off keys stored, merged into the metadata the chat
 * already has. A chat with nothing turned off carries no flag. Every flag is a short key
 * with a one-character value, so no connector name can push a value past its 128-character
 * cap. Only keys made by connectorOffKey are accepted, so a raw name cannot slip in.
 */
export function withTurnedOffConnectorKeys(
  metadata: Record<string, string> | null | undefined,
  keys: readonly string[],
): Record<string, string> {
  if (!keys.every(key => CONNECTOR_OFF_KEY.test(key))) {
    throw new Error('An add-on choice was not in the form the app saves. This is a bug in the app. Please report it.');
  }
  const rest = Object.fromEntries(
    Object.entries(metadata ?? {}).filter(([key]) => !key.startsWith(CONNECTOR_OFF_KEY_PREFIX)),
  );
  return { ...rest, ...Object.fromEntries([...new Set(keys)].map(key => [key, '1'])) };
}
