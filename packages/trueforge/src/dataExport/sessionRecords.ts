/**
 * Session data as the export writes it: stored records minus fields that are
 * live pointers into this deployment (approval tokens, sandbox handles, OAuth
 * links) and mean nothing, or leak access, anywhere else.
 */
import type { PersistedTurnEvent } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/core';

/** Keys removed wherever they appear in a session, its turns, snapshots and events. */
const DEPLOYMENT_BOUND_KEYS: ReadonlySet<string> = new Set(['approval_token_id', 'sandbox_info', 'auth_url']);

/** Plain JSON copy of `value` without the deployment-bound keys. */
export function withoutDeploymentBoundFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutDeploymentBoundFields);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!DEPLOYMENT_BOUND_KEYS.has(key)) {
        out[key] = withoutDeploymentBoundFields(entry);
      }
    }
    return out;
  }
  return value;
}

/** Sandbox creation events only announce a provider handle, so they are left out entirely. */
export function exportableEvents(events: readonly PersistedTurnEvent[]): PersistedTurnEvent[] {
  return events.filter(event => event.type !== EventType.SANDBOX_CREATED);
}
