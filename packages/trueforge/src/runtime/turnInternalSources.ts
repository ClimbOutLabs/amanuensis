import type { SessionHandle, TurnHandle, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import type { Logger } from 'winston';

import type { IModelProviderStore } from '../db/modelProviderStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { createKnowledgeRelevanceJudge } from '../personaKnowledge/knowledgeRelevanceJudge';
import type { PersonaKnowledgeHit } from '../personaKnowledge/knowledgeRetrieval';
import { extractKnowledgeQuery, resolvePersonaKnowledgeBlock } from '../personaKnowledge/knowledgeTurnContext';
import {
  createInternalSourceState,
  PERSONA_LIBRARY_NEAR_MISS_MARKER,
  type InternalSourceState,
} from './internalSourceGuard';

/** Internal-source facts for one turn, resolved before the turn exists. */
export interface TurnInternalSources {
  /**
   * Shared by the knowledge lookup (recorded here), the memory capability
   * (records what recall injected), and the turn's web_search policy.
   */
  internalSourceState: InternalSourceState;
  /**
   * Retrieved passages for the active persona, or the near-miss host fact when
   * the library was consulted and the relevance judge kept nothing.
   */
  personaKnowledgeBlock: string | undefined;
  /** The hits behind the block, for attribution enforcement on the final message. */
  personaKnowledgeHits: readonly PersonaKnowledgeHit[] | undefined;
  /** Carried on the turn record so a later approval resubmission can re-arm the library rule. */
  libraryNearMiss: true | null;
}

/**
 * Newest-first input snapshots walking back past resubmission turns (which
 * carry no user message), plus whether the immediate previous turn recorded a
 * library near-miss. The walk ends at the first user-authored question, the
 * root, or a missing turn; a visited set guards against a corrupt cycle.
 */
async function collectLibraryFallbackContext(input: {
  session: SessionHandle<SessionCustom, TurnCustom>;
  previousTurnId: string | null | undefined;
  previousTurn: TurnHandle<TurnCustom> | undefined;
}): Promise<{ historyInputs: TurnInputItem[][]; previousTurnNearMiss: boolean }> {
  const historyInputs: TurnInputItem[][] = [];
  let previousTurnNearMiss = false;
  const seen = new Set<string>();
  let turnId = input.previousTurnId ?? null;
  let turn = input.previousTurn;
  for (;;) {
    if (turn === undefined) {
      if (turnId === null || seen.has(turnId)) {
        break;
      }
      seen.add(turnId);
      turn = await input.session.getTurn(turnId).catch(() => undefined);
      if (turn === undefined) {
        break;
      }
    }
    if (historyInputs.length === 0) {
      previousTurnNearMiss = turn.custom?.library_near_miss === true;
    }
    historyInputs.push(turn.input);
    if (extractKnowledgeQuery(turn.input) !== undefined) {
      break;
    }
    turnId = turn.previous_turn_id;
    turn = undefined;
  }
  return { historyInputs, previousTurnNearMiss };
}

/**
 * One read per turn of the active persona's knowledge library, judged by the
 * persona's own model. Never throws: an unavailable library degrades to no
 * block rather than failing the turn.
 */
export async function resolveTurnInternalSources(input: {
  session: SessionHandle<SessionCustom, TurnCustom>;
  previousTurnId: string | null | undefined;
  /** Already-loaded previous turn, when the caller has one. */
  previousTurn?: TurnHandle<TurnCustom> | undefined;
  persona: { id: string; modelName: string } | undefined;
  turnInput: TurnInputItem[] | undefined;
  knowledgeDir: string;
  modelDir: string;
  modelProviderStore: IModelProviderStore;
  logger: Logger;
}): Promise<TurnInternalSources> {
  const internalSourceState = createInternalSourceState();
  const libraryFallback = await collectLibraryFallbackContext({
    session: input.session,
    previousTurnId: input.previousTurnId,
    previousTurn: input.previousTurn,
  });
  const tenantId = input.session.tenant_id;
  const knowledge = await resolvePersonaKnowledgeBlock({
    personaId: input.persona?.id,
    tenantId,
    turnInput: input.turnInput,
    historyInputs: libraryFallback.historyInputs,
    previousTurnNearMiss: libraryFallback.previousTurnNearMiss,
    knowledgeDir: input.knowledgeDir,
    modelDir: input.modelDir,
    logger: input.logger,
    judge:
      input.persona === undefined
        ? undefined
        : createKnowledgeRelevanceJudge({
            tenantId,
            modelName: input.persona.modelName,
            modelProviderStore: input.modelProviderStore,
            logger: input.logger,
          }),
    sourceState: internalSourceState,
  });
  const nearMiss = internalSourceState.libraryConsulted && !internalSourceState.libraryAnswered;
  return {
    internalSourceState,
    // A near-miss names that host fact so the turn answers from the library or
    // reports its absence instead of web-divining one.
    personaKnowledgeBlock: knowledge?.block ?? (nearMiss ? PERSONA_LIBRARY_NEAR_MISS_MARKER : undefined),
    personaKnowledgeHits: knowledge?.hits,
    libraryNearMiss: nearMiss ? true : null,
  };
}
