/**
 * Builds and submits the retain call for one completed turn's exchange.
 *
 * The host is the only writer (design invariant 4): every retain submission uses a
 * deterministic operation id derived from `(session_id, turn_id)`, so submitting the same
 * exchange twice (the drain hook's own submission, and the capability's reliability-loop
 * resubmission for a vanished operation) is a no-op on the memory provider's side.
 */
import type { Logger } from 'winston';
import configuration from '../../config';
import type { HindsightClient, RetainItem } from './hindsightClient';
import { uuidv5 } from './uuidv5';

/** Fixed namespace for every operation id this host mints, in the style of RFC 4122's example namespaces. */
export const AMAN_MEMORY_NAMESPACE = 'b6d6d9ad-6f92-5a2c-9d61-1c8e254f0d6b';

/** Metadata key carrying a memory's provenance, read back at recall to pick a screening posture. */
export const MEMORY_ORIGIN_METADATA_KEY = 'origin';

/**
 * Provenance stamped on every host-written memory:
 * - `user_stated`: the turn produced no untrusted tool output, so the retained exchange is the
 *   user's own voice and the model's reply to it.
 * - `tool_ingested`: the turn ingested at least one tool result. All tool output is untrusted
 *   data (the host says so in the system prompt), so the model's reply may echo injected content;
 *   the recall screen holds such memories to a stricter posture.
 *
 * The external N8N pipeline writes its own origins (`email`, `document`) straight into the bank,
 * bypassing this path entirely; the recall screen treats every origin that is not `user_stated`
 * (those included, and absent legacy metadata) as untrusted, so this union stays the host-written
 * set without having to enumerate the pipeline's.
 */
export type AmanMemoryOrigin = 'user_stated' | 'tool_ingested';

/** The one origin the recall screen trusts as the user's own voice (see {@link AmanMemoryOrigin}). */
export const USER_STATED_ORIGIN = 'user_stated';

/** Deterministic retain operation id for one turn's exchange. */
export function retainOperationId(params: { sessionId: string; turnId: string }): string {
  return uuidv5({ name: `${params.sessionId}/${params.turnId}`, namespace: AMAN_MEMORY_NAMESPACE });
}

export interface BuildRetainItemParams {
  sessionId: string;
  turnId: string;
  userText: string;
  assistantText: string;
  completedAt: string;
  sessionTitle?: string | undefined;
  /** Provenance for the screening posture at recall. Defaults to `user_stated`. */
  origin?: AmanMemoryOrigin | undefined;
}

/**
 * Returns undefined when there is nothing worth retaining (both sides empty).
 *
 * Lossless by design: this never drops or gates a memory on its origin. It only stamps the origin
 * so the recall screen can decide, later and per turn, which recalled items reach the model.
 */
export function buildRetainItem(params: BuildRetainItemParams): RetainItem | undefined {
  const userText = params.userText.trim();
  const assistantText = params.assistantText.trim();
  if (!userText && !assistantText) {
    return undefined;
  }
  const item: RetainItem = {
    content: `User: ${userText}\n\nAssistant: ${assistantText}`,
    timestamp: params.completedAt,
    document_id: `aman-${params.sessionId}-${params.turnId}`,
    metadata: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      source: 'aman-chat',
      [MEMORY_ORIGIN_METADATA_KEY]: params.origin ?? USER_STATED_ORIGIN,
    },
  };
  if (params.sessionTitle !== undefined) {
    item.context = params.sessionTitle;
  }
  return item;
}

export interface SubmitRetainParams {
  client: HindsightClient;
  sessionId: string;
  turnId: string;
  userText: string;
  assistantText: string;
  completedAt: string;
  sessionTitle?: string | undefined;
  /** Provenance for the screening posture at recall. Defaults to `user_stated`. */
  origin?: AmanMemoryOrigin | undefined;
  logger: Logger;
}

/**
 * Fire-and-forget retain submission for one turn. Never throws: a memory-provider failure
 * here must never fail or delay the turn it belongs to. This function does not record any
 * pending-operation state: the capability's own sweep (hydrated from durable capability
 * state) is the retry path for a submission that never reached the provider.
 */
export async function submitRetain(params: SubmitRetainParams): Promise<void> {
  const item = buildRetainItem(params);
  if (item === undefined) {
    return;
  }
  try {
    const outcome = await params.client.retain({
      items: [item],
      operationId: retainOperationId({ sessionId: params.sessionId, turnId: params.turnId }),
      timeoutMs: configuration.MEMORY_RETAIN_TIMEOUT_MS,
    });
    if (!outcome.ok) {
      params.logger.warn('Memory retain submission failed', {
        sessionId: params.sessionId,
        turnId: params.turnId,
        reason: outcome.reason,
      });
    }
  } catch (error) {
    params.logger.warn('Memory retain submission threw unexpectedly', {
      sessionId: params.sessionId,
      turnId: params.turnId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
