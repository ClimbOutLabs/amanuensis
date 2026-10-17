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
import type { IModelProviderStore } from '../../db/modelProviderStore';
import type { TurnModelUsage } from '../modelUsage';
import type { TokenFactoryBudget } from '../tokenFactoryBudget';
import type { RetainItem } from './hindsightClient';
import { isOperationCompletedStatus, isOperationFailedStatus } from './hindsightClient';
import type { MemoryClient } from './memoryClient';
import { summarizeTurnContent } from './memorySummarize';
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

/** The one origin the recall screen trusts as the user's own voice (see AmanMemoryOrigin above). */
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
  /**
   * Pre-summarized turn content. When present, it is stored with a visible `Turn summary:`
   * prefix instead of the verbatim `User:`/`Assistant:` transcript; the transcript is not
   * stored. Only set when `MEMORY_SUMMARIZE` produced a summary for this turn.
   *
   * Screening adjudication: a summary inherits the turn's origin unchanged. Summarization
   * is a faithful compression, not a trust upgrade — a summary of a tool_ingested turn
   * stays tool_ingested (the summarizer treats the exchange as untrusted and may echo
   * injected content), and a user_stated turn stays user_stated.
   */
  summarizedContent?: string | undefined;
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
  const summarizedContent = params.summarizedContent?.trim();
  const summarized = summarizedContent !== undefined && summarizedContent !== '';
  const item: RetainItem = {
    content: summarized ? `Turn summary: ${summarizedContent}` : `User: ${userText}\n\nAssistant: ${assistantText}`,
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

/**
 * Context for LLM summarization of a turn. Canonical shape shared by the turn drain
 * input and the retain params: both must agree, so it is defined once here.
 */
export interface SummarizeTurnContext {
  tenantId: string;
  modelProviderStore: IModelProviderStore;
  /** Model to summarize with; an undefined/blank value skips summarization. */
  summarizationModelFqn: string | undefined;
  tokenFactoryBudget: TokenFactoryBudget;
  modelUsage: TurnModelUsage;
}

export interface SubmitRetainParams {
  client: MemoryClient;
  sessionId: string;
  turnId: string;
  userText: string;
  assistantText: string;
  completedAt: string;
  sessionTitle?: string | undefined;
  /** Provenance for the screening posture at recall. Defaults to `user_stated`. */
  origin?: AmanMemoryOrigin | undefined;
  logger: Logger;
  /**
   * Context for LLM summarization of the turn. Present only when turn summarization was
   * enabled for the turn (the Settings toggle's persisted override, else the
   * `MEMORY_SUMMARIZE` env default, resolved once per turn by `resolveTurnSummarizeContext`);
   * when the summarization fails or yields nothing, the verbatim transcript is retained instead.
   * Absent means never summarize (verbatim always).
   */
  summarize?: SummarizeTurnContext | undefined;
}

/**
 * Fire-and-forget retain submission for one turn. Never throws: a memory-provider failure
 * here must never fail or delay the turn it belongs to. This function does not record any
 * pending-operation state: the capability's own sweep (hydrated from durable capability
 * state) is the retry path for a submission that never reached the provider.
 */
export async function submitRetain(params: SubmitRetainParams): Promise<void> {
  await attemptRetainSubmission(params);
}

/** Outcome of one retain submission attempt; `skipped` means there was nothing to retain. */
type RetainSubmissionResult = 'submitted' | 'failed' | 'skipped';

/**
 * Summarizes the turn via the LLM when summarization context was provided. The context is
 * present only when turn summarization is enabled for the turn (the Settings toggle's
 * persisted override, else the `MEMORY_SUMMARIZE` env default, resolved once per turn by
 * `resolveTurnSummarizeContext`), so its presence is the enablement signal — no second
 * flag read. Returns the summary, or `undefined` to retain the verbatim transcript: every
 * failure (no context, model error, empty result) falls back to verbatim so a memory is
 * never lost to summarization. Every non-summarizing outcome is logged at debug so the
 * effective state stays observable; the retain path must never silently store verbatim
 * while the Settings toggle claims summaries are produced.
 */
async function maybeSummarizeTurn(params: SubmitRetainParams): Promise<string | undefined> {
  const summarize = params.summarize;
  if (summarize === undefined) {
    params.logger.debug('Turn summarization context not provided; retaining the verbatim transcript', {
      sessionId: params.sessionId,
      turnId: params.turnId,
    });
    return undefined;
  }
  try {
    const result = await summarizeTurnContent({
      userText: params.userText,
      assistantText: params.assistantText,
      tenantId: summarize.tenantId,
      modelProviderStore: summarize.modelProviderStore,
      summarizationModelFqn: summarize.summarizationModelFqn,
      tokenFactoryBudget: summarize.tokenFactoryBudget,
      modelUsage: summarize.modelUsage,
      logger: params.logger,
    });
    if (result.status === 'summarized') {
      params.logger.debug('Turn summarized; storing the summary instead of the verbatim transcript', {
        sessionId: params.sessionId,
        turnId: params.turnId,
        summaryLength: result.summary.length,
      });
      return result.summary;
    }
    if (result.status === 'failed') {
      params.logger.debug('Memory summarization failed; falling back to verbatim transcript', {
        reason: result.reason,
      });
    } else {
      // `skipped` is an intentional no-op, but the reason must stay observable: a turn
      // that never summarizes (no model configured, overlong exchange) is otherwise
      // indistinguishable from a disabled toggle in the retained output.
      params.logger.debug('Memory summarization skipped; falling back to verbatim transcript', {
        reason: result.reason,
      });
    }
    return undefined;
  } catch (error) {
    params.logger.debug('Memory summarization threw; falling back to verbatim transcript', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function attemptRetainSubmission(
  params: SubmitRetainParams,
  /**
   * Precomputed summarization result. When the wrapper is provided (even with
   * `summarizedContent: undefined`), the LLM is NOT invoked again — the caller
   * already attempted summarization. When absent, summarization is attempted here.
   */
  precomputed?: { summarizedContent: string | undefined },
): Promise<RetainSubmissionResult> {
  // Use the precomputed summary if the caller already attempted summarization;
  // otherwise attempt it now. The wrapper distinguishes "attempted (undefined result)"
  // from "not attempted", so a failed LLM call is never retried.
  const summary = precomputed !== undefined ? precomputed.summarizedContent : await maybeSummarizeTurn(params);
  const item = buildRetainItem({ ...params, summarizedContent: summary });
  if (item === undefined) {
    return 'skipped';
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
      return 'failed';
    }
    return 'submitted';
  } catch (error) {
    params.logger.warn('Memory retain submission threw unexpectedly', {
      sessionId: params.sessionId,
      turnId: params.turnId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

/**
 * Retain submission with one bounded verification pass, for the turn event drain.
 *
 * The drain's submission used to be single-shot: when it failed, the only retry was the next
 * turn's sweep, so a session's final turn could lose its memory silently. After the submission
 * settles, this runs one sweep-equivalent pass over the deterministic operation id: one status
 * check, then at most one recovery — retryOperation for a failed op, or a resubmission of the
 * exact exchange when the op is missing or unreadable. The deterministic id makes resubmission
 * idempotent, and a queued or running op is left for the next sweep. Never throws; a
 * still-unverified op is logged with its operation id rather than dropped silently.
 */
export async function submitRetainWithVerification(params: SubmitRetainParams): Promise<void> {
  // Precompute the summary once; the retry path below must reuse it rather than
  // invoking the LLM a second time (cost, latency, and non-determinism).
  // The wrapper ensures even an undefined result is not recomputed.
  const precomputed = { summarizedContent: await maybeSummarizeTurn(params) };
  const result = await attemptRetainSubmission(params, precomputed);
  if (result === 'skipped') {
    return;
  }
  const operationId = retainOperationId({ sessionId: params.sessionId, turnId: params.turnId });
  const timeoutMs = configuration.MEMORY_RETAIN_TIMEOUT_MS;
  try {
    const check = await params.client.getOperation(operationId, timeoutMs);
    if (check.ok) {
      if (isOperationCompletedStatus(check.status)) {
        return;
      }
      if (isOperationFailedStatus(check.status)) {
        const retried = await params.client.retryOperation(operationId, timeoutMs);
        if (!retried.ok) {
          params.logger.warn('Memory retain retry failed for failed operation', {
            sessionId: params.sessionId,
            turnId: params.turnId,
            operationId,
          });
        }
        return;
      }
      if (check.status === 'unknown') {
        // Vanished (or never landed): resubmit the exact exchange once.
        // Reuse the precomputed summary; do not invoke the LLM again.
        const retryResult = await attemptRetainSubmission(params, precomputed);
        if (retryResult !== 'submitted') {
          params.logger.warn('Memory retain unverified after single retry pass', {
            sessionId: params.sessionId,
            turnId: params.turnId,
            operationId,
          });
        }
        return;
      }
      // Still queued/running (or an unrecognized status): leave it for the next turn's sweep.
      params.logger.debug('Memory retain operation still pending after drain submission', {
        sessionId: params.sessionId,
        turnId: params.turnId,
        operationId,
        status: check.status,
      });
      return;
    }
    // Status unreadable: one deterministic resubmission is safe and may recover a submission
    // whose response was lost. Reuse the precomputed summary; do not invoke the LLM again.
    const retryResult = await attemptRetainSubmission(params, precomputed);
    if (retryResult !== 'submitted') {
      params.logger.warn('Memory retain unverified after single retry pass', {
        sessionId: params.sessionId,
        turnId: params.turnId,
        operationId,
        reason: check.reason,
      });
    }
  } catch (error) {
    params.logger.warn('Memory retain verification pass threw unexpectedly', {
      sessionId: params.sessionId,
      turnId: params.turnId,
      operationId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
