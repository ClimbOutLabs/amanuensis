import { hashCanonicalParams, type ConnectorIdentity } from '@truefoundry/trueforge-core/core';

import type { McpServerRecord } from '../db/mcpServerStore';

/**
 * A standing tool grant holds only while the connector keeps the URL and auth settings it was
 * chosen under; the digest covers both, so a repoint or a credential change ends it.
 */
export function connectorIdentity(record: Pick<McpServerRecord, 'id' | 'manifest'>): ConnectorIdentity {
  return {
    id: record.id,
    fingerprint: hashCanonicalParams({ url: record.manifest.url, auth: record.manifest.auth ?? null }),
  };
}
