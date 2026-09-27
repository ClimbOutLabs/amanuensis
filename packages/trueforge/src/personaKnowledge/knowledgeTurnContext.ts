import type { TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { isAgentInputUserMessage, isFileContentPart } from '@truefoundry/trueforge-core/core';

import { noteLibraryLookup, type InternalSourceState } from '../runtime/internalSourceGuard';
import { retrievePersonaKnowledge } from './knowledgeRetrieval';
import type { KnowledgeRelevanceJudge } from './knowledgeRelevanceJudge';
import type { PersonaKnowledgeHit } from './knowledgeRetrieval';

/**
 * The user-authored text of the turn, with file parts dropped: the knowledge
 * query. Only the first user message is read, matching persona selection —
 * retrieval answers what the user just said, not file content or history.
 */
export function extractKnowledgeQuery(input: TurnInputItem[] | undefined): string | undefined {
  const firstUserMessage = input?.find(isAgentInputUserMessage);
  if (firstUserMessage === undefined) {
    return undefined;
  }
  const text =
    typeof firstUserMessage.content === 'string'
      ? firstUserMessage.content
      : firstUserMessage.content
          .filter(part => !isFileContentPart(part))
          .map(part => part.text)
          .join(' ');
  const trimmed = text.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Latest user-authored question across newest-first history input arrays.
 * Only the policy question is re-derived from history — retrieval itself is
 * never re-run on history input.
 */
export function extractHistoryKnowledgeQuery(
  historyInputs: TurnInputItem[][] | undefined,
): string | undefined {
  if (historyInputs === undefined) {
    return undefined;
  }
  for (const historyInput of historyInputs) {
    const question = extractKnowledgeQuery(historyInput);
    if (question !== undefined) {
      return question;
    }
  }
  return undefined;
}

/**
 * Resolved persona knowledge for a turn: the injected prompt block plus the
 * hits behind it, so the turn finalization hook can enforce attribution on
 * the assistant's final message. Returns undefined when no persona is
 * active, no question, or nothing relevant is found — including the
 * near-miss (the floor produced candidates but the judge kept none), which
 * is recorded as consulted-without-answer on the source state so the turn
 * can name that host fact. Never throws: retrieval degrades silently so a
 * knowledge failure can never fail the turn.
 *
 * Approval/tool-response resubmissions carry no user message (the request
 * schema forbids mixing them), so there is nothing input-scoped to retrieve.
 * When the previous turn recorded a near-miss, the policy is re-armed from
 * the latest user-authored question in the history snapshot instead — the
 * consulted/answered outcome is carried, never re-derived, and retrieval
 * does not re-run.
 */
export interface PersonaKnowledgeTurnContext {
  block: string;
  hits: PersonaKnowledgeHit[];
}

export async function resolvePersonaKnowledgeBlock(input: {
  personaId: string | undefined;
  tenantId: string;
  turnInput: TurnInputItem[] | undefined;
  knowledgeDir: string;
  modelDir: string;
  logger: { warn(message: string): void };
  /**
   * Semantic filter over the floor-surviving candidates, built by the caller
   * against the turn's model. Retrieval itself stays brain-agnostic.
   */
  judge?: KnowledgeRelevanceJudge | undefined;
  /**
   * Per-turn internal-source state. The lookup outcome is recorded here so
   * the turn's tool policy can tell "the library was asked and answered
   * nothing" apart from "the library was never relevant".
   */
  sourceState?: InternalSourceState | undefined;
  /**
   * Newest-first input snapshots of previous turns. Read only when the
   * current turn's input carries no user question, to re-arm the policy
   * from the latest user-authored question without re-running retrieval.
   */
  historyInputs?: TurnInputItem[][] | undefined;
  /**
   * Whether the previous turn recorded a persona-library near-miss. The
   * per-turn source state is dropped with the turn, so the outcome is
   * carried on the turn record — only the outcome, never the query text.
   */
  previousTurnNearMiss?: boolean | undefined;
}): Promise<PersonaKnowledgeTurnContext | undefined> {
  if (input.personaId === undefined) {
    return undefined;
  }
  const question = extractKnowledgeQuery(input.turnInput);
  if (question === undefined) {
    const historyQuestion = extractHistoryKnowledgeQuery(input.historyInputs);
    if (historyQuestion !== undefined && input.previousTurnNearMiss === true) {
      noteLibraryLookup(input.sourceState, {
        query: historyQuestion,
        consulted: true,
        answered: false,
      });
    }
    return undefined;
  }
  const result = await retrievePersonaKnowledge({
    tenantId: input.tenantId,
    personaId: input.personaId,
    question,
    knowledgeDir: input.knowledgeDir,
    modelDir: input.modelDir,
    logger: input.logger,
    judge: input.judge,
  });
  noteLibraryLookup(input.sourceState, {
    query: question,
    consulted: (result?.floorHits ?? 0) > 0,
    // Answered means the judge kept at least one passage: a near-miss result
    // carries an undefined block, so block-presence (not result-presence) is
    // the answered signal.
    answered: result?.block !== undefined,
  });
  // A near-miss (floor produced candidates but the judge kept none) carries
  // an undefined block: return undefined so the caller can name that host
  // fact via the near-miss marker instead of injecting an empty section.
  // hits is empty in that case, so no attribution data is lost.
  if (result?.block === undefined) {
    return undefined;
  }
  return { block: result.block, hits: result.hits };
}
