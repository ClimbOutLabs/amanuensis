import type { SessionAgent, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields, isAgentInputUserMessage, isFileContentPart } from '@truefoundry/trueforge-core/core';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'winston';
import type { IAgentStore } from '../db/agentStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { IPersonaStore } from '../db/personaStore';
import type { TurnCustom, TurnPersonaSnapshot } from '../db/sessionCustom';
import {
  buildPersonaContext,
  matchPersonaInvocation,
  type Persona,
  type PersonaActivation,
  type PersonaActivationSource,
  type PersonaContext,
} from '../personas/persona';
import {
  classifyPersonaIntent,
  isUnambiguousDirectPersonaInvocation,
  shouldClassifyPersonaIntent,
} from './personaIntent';
import { getModelDetails } from './sessionResources';

/** The persona a turn runs as, and why it was chosen. */
export type TurnPersonaResolution =
  | {
      kind: 'persona';
      persona: Persona;
      source: Extract<PersonaActivationSource, 'invocation' | 'sticky'>;
      selection: 'direct' | 'semantic' | 'sticky';
      context: PersonaContext;
    }
  | {
      kind: 'default';
      source: Extract<PersonaActivationSource, 'default'>;
      selection: 'semantic';
    };

/**
 * The user-authored text of the turn, with file parts dropped.
 *
 * Only the first user message is read: selection belongs to what the user just
 * said, not file content, approval continuations, or older chat history.
 */
function turnInvocationText(input: TurnInputItem[] | undefined): string | undefined {
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
 * Confirms a persona's model is still configured.
 *
 * Failure is visible and keeps the assignment: a persona bound to a model that
 * has gone away must say so, never quietly answer on a different one. Work
 * attributed to a model that did not do it is the failure this whole feature
 * exists to avoid.
 */
export async function assertPersonaModelAvailable(input: {
  displayName: string;
  modelName: string;
  tenant_id: string;
  modelProviderStore: IModelProviderStore;
}): Promise<void> {
  try {
    await getModelDetails({ tenant_id: input.tenant_id, name: input.modelName, store: input.modelProviderStore });
  } catch (error) {
    if (error instanceof HTTPException) {
      throw new HTTPException(422, {
        message: `Persona "${input.displayName}" is assigned model "${input.modelName}", which is unavailable: ${error.message}`,
        cause: error,
      });
    }
    throw error;
  }
}

function samePersonaRevision(input: { left: Persona; right: Persona }): boolean {
  return (
    input.left.id === input.right.id &&
    input.left.updated_at === input.right.updated_at &&
    input.left.display_name === input.right.display_name &&
    input.left.model_name === input.right.model_name &&
    input.left.instructions === input.right.instructions &&
    input.left.aliases.length === input.right.aliases.length &&
    input.left.aliases.every((alias, index) => alias === input.right.aliases[index])
  );
}

/** Confirms the persona snapshot selected before admission still exists unchanged. */
export async function isTurnPersonaResolutionCurrent(input: {
  resolution: TurnPersonaResolution;
  personaStore: IPersonaStore;
  tenant_id: string;
  created_by: string;
}): Promise<boolean> {
  if (input.resolution.kind === 'default') {
    return true;
  }
  const current = await input.personaStore.getPersona({
    tenant_id: input.tenant_id,
    created_by: input.created_by,
    id: input.resolution.persona.id,
  });
  return current !== undefined && samePersonaRevision({ left: input.resolution.persona, right: current });
}

/**
 * Decides which persona and model are selected for this turn.
 *
 * Precedence, strongest first: a deterministic direct invocation, one bounded
 * semantic selection when the message names a configured identity, then the
 * persona this branch is already talking to. The semantic pass classifies only
 * an explicit change of speaker; it never infers a persona from the topic.
 * With no personas configured the path costs one indexed read and the turn
 * behaves exactly as it did before personas existed.
 *
 * A sticky persona that has since been deleted resolves to the default
 * assistant. That is not a silent substitution: the user removed it.
 */
export async function resolveTurnPersona(input: {
  personaStore: IPersonaStore;
  modelProviderStore: IModelProviderStore;
  agentStore: IAgentStore;
  sessionAgent: SessionAgent;
  logger: Logger;
  defaultAssistantName: string | null | undefined;
  tenant_id: string;
  created_by: string;
  session_id: string;
  turnInput: TurnInputItem[] | undefined;
  previousTurnCustom: TurnCustom | null | undefined;
  latestManualActivation: PersonaActivation | undefined;
  legacyParentActivation: PersonaActivation | undefined;
  latestManualActivationAfterParent: PersonaActivation | undefined;
}): Promise<TurnPersonaResolution | undefined> {
  const personas = await input.personaStore.listPersonas({
    tenant_id: input.tenant_id,
    created_by: input.created_by,
  });
  if (personas.length === 0) {
    return undefined;
  }

  const text = turnInvocationText(input.turnInput);
  const invoked = text === undefined ? undefined : matchPersonaInvocation({ text, personas });
  const sticky = stickyPersona({ ...input, personas });
  let resolution:
    | { persona: Persona; source: 'invocation' | 'sticky'; selection: 'direct' | 'semantic' | 'sticky' }
    | { source: 'default'; selection: 'semantic' }
    | undefined;
  if (
    invoked !== undefined &&
    text !== undefined &&
    isUnambiguousDirectPersonaInvocation({
      message: text,
      persona: invoked.persona,
      defaultAssistantName: input.defaultAssistantName,
      personas,
    })
  ) {
    resolution = { persona: invoked.persona, source: 'invocation', selection: 'direct' };
  } else if (
    text !== undefined &&
    shouldClassifyPersonaIntent({
      message: text,
      currentPersona: sticky?.persona,
      defaultAssistantName: input.defaultAssistantName,
      personas,
    })
  ) {
    try {
      const intent = await classifyPersonaIntent({
        message: text,
        currentPersona: sticky?.persona,
        defaultAssistantName: input.defaultAssistantName,
        personas,
        tenantId: input.tenant_id,
        sessionAgent: input.sessionAgent,
        agentStore: input.agentStore,
        modelProviderStore: input.modelProviderStore,
        logger: input.logger,
        sessionId: input.session_id,
      });
      if (intent?.action === 'select_persona') {
        const selected = personas.find(persona => persona.id === intent.persona_id);
        resolution =
          selected === undefined ? sticky : { persona: selected, source: 'invocation', selection: 'semantic' };
      } else if (intent?.action === 'select_default') {
        resolution = sticky === undefined ? undefined : { source: 'default', selection: 'semantic' };
      } else {
        resolution = sticky;
      }
    } catch (error) {
      input.logger.warn('Persona selection preflight failed; keeping the current persona', {
        sessionId: input.session_id,
        ...extractErrorLogFields(error),
      });
      resolution = sticky;
    }
  } else {
    resolution = sticky;
  }
  if (resolution === undefined) {
    return undefined;
  }

  if (!('persona' in resolution)) {
    return { kind: 'default', source: 'default', selection: resolution.selection };
  }

  await assertPersonaModelAvailable({
    displayName: resolution.persona.display_name,
    modelName: resolution.persona.model_name,
    tenant_id: input.tenant_id,
    modelProviderStore: input.modelProviderStore,
  });
  return { kind: 'persona', ...resolution, context: buildPersonaContext(resolution.persona) };
}

function stickyPersona(input: {
  personas: Persona[];
  previousTurnCustom: TurnCustom | null | undefined;
  latestManualActivation: PersonaActivation | undefined;
  legacyParentActivation: PersonaActivation | undefined;
  latestManualActivationAfterParent: PersonaActivation | undefined;
}): { persona: Persona; source: 'sticky'; selection: 'sticky' } | undefined {
  const previous = input.previousTurnCustom;
  const latestManualId = input.latestManualActivation?.id ?? null;

  // A manual selection made after the parent turn overrides that branch's
  // snapshot. Otherwise inherit from the actual parent, never from the newest
  // audit row written by some concurrent fork.
  let active: TurnPersonaSnapshot | PersonaActivation | null | undefined;
  if (previous !== null && previous !== undefined && Object.hasOwn(previous, 'persona')) {
    const previousManualId = previous.manual_persona_activation_id ?? null;
    active = latestManualId !== previousManualId ? input.latestManualActivation : previous.persona;
  } else {
    // Legacy turns predate the atomic snapshot. Their exact activation is the
    // only branch-safe inheritance source. A manual choice made after that
    // turn still wins; without a parent activation, the latest manual choice
    // is the compatibility fallback.
    active = input.latestManualActivationAfterParent ?? input.legacyParentActivation ?? input.latestManualActivation;
  }
  const personaId = active?.persona_id ?? null;
  if (personaId == null) {
    return undefined;
  }
  const persona = input.personas.find(candidate => candidate.id === personaId);
  return persona === undefined ? undefined : { persona, source: 'sticky', selection: 'sticky' };
}
