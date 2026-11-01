import type { Logger } from 'winston';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';

/**
 * Reads the per-person past-chat search switch. The search reads the person's own words,
 * so a read that fails keeps the search off: the tool is only offered when the stored
 * setting says yes. (Memory recall fails open instead; this switch is an opt-in to a
 * new reader, so it fails closed.)
 */
export async function readChatSearchEnabled(deps: {
  sentinelSettingsStore: ISentinelSettingsStore | undefined;
  tenant_id: string;
  created_by: string;
  logger: Logger;
}): Promise<boolean> {
  if (deps.sentinelSettingsStore === undefined) {
    return false;
  }
  try {
    const settings = await deps.sentinelSettingsStore.get({
      tenant_id: deps.tenant_id,
      created_by: deps.created_by,
    });
    return settings.chat_search_enabled;
  } catch (error) {
    deps.logger.warn('Past-chat search stays off because the setting could not be read.', {
      err: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
