/** Session metadata key for the chat-level "Agent details" preference (wire/jsonb snake_case). */
export const AGENT_DETAILS_METADATA_KEY = 'agent_details';

/** Whether a chat's agent internals (tool calls, reasoning steps) render expanded for every turn. */
export type AgentDetailsVisibility = 'expanded' | 'collapsed';

function isAgentDetailsVisibility(value: unknown): value is AgentDetailsVisibility {
  return value === 'expanded' || value === 'collapsed';
}

/**
 * Read the preference from session metadata.
 * Missing / undefined / unrecognized value → undefined (unset; renders collapsed by default).
 */
export function readSessionAgentDetails(
  metadata: Record<string, string> | null | undefined,
): AgentDetailsVisibility | undefined {
  if (metadata == null) return undefined;
  const value = Reflect.get(metadata, AGENT_DETAILS_METADATA_KEY);
  return isAgentDetailsVisibility(value) ? value : undefined;
}

/** String-valued metadata off a loosely-typed UI session object. */
export function sessionMetadataRecord(session: object): Record<string, string> {
  if (!('metadata' in session)) return {};
  const metadata = Reflect.get(session, 'metadata');
  if (typeof metadata !== 'object' || metadata === null) return {};
  const record: Record<string, string> = {};
  for (const key of Object.keys(metadata)) {
    const value = Reflect.get(metadata, key);
    if (typeof value === 'string') record[key] = value;
  }
  return record;
}

/**
 * Read the preference off a UI session (own `agentDetails` prop when the adapter stamped one,
 * else its `metadata`). Mirrors `sessionIsCreateAgent` in `sessionCreateAgent.ts`.
 */
export function sessionAgentDetails(session: object): AgentDetailsVisibility | undefined {
  if ('agentDetails' in session) {
    const own = Reflect.get(session, 'agentDetails');
    if (isAgentDetailsVisibility(own)) return own;
  }
  return readSessionAgentDetails(sessionMetadataRecord(session));
}

/** Merge the preference into a session's existing metadata, for a metadata PATCH that must not drop other keys. */
export function withSessionAgentDetails(session: object, value: AgentDetailsVisibility): Record<string, string> {
  return { ...sessionMetadataRecord(session), [AGENT_DETAILS_METADATA_KEY]: value };
}
