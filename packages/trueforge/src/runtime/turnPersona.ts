import type { TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { isAgentInputUserMessage, isFileContentPart } from '@truefoundry/trueforge-core/core';
import { HTTPException } from 'hono/http-exception';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { IPersonaStore } from '../db/personaStore';
import type { TurnCustom, TurnPersonaSnapshot } from '../db/sessionCustom';
import {
  buildPersonaContext,
  matchPersonaInvocation,
  personaMatchKey,
  personaNameKeys,
  type Persona,
  type PersonaActivation,
  type PersonaActivationSource,
  type PersonaContent,
  type PersonaContext,
} from '../personas/persona';
import { isUnambiguousDirectPersonaInvocation } from './personaIntent';
import type { PersonaSwitchNotice } from './PersonaTurnResourceResolver';
import { getModelDetails } from './sessionResources';

/** The persona a turn runs as, and why it was chosen. */
export type TurnPersonaResolution =
  | {
      kind: 'persona';
      persona: Persona;
      source: Extract<PersonaActivationSource, 'invocation' | 'sticky'>;
      selection: 'direct' | 'semantic' | 'sticky';
      context: PersonaContext;
      /** Model-visible notice for an ambiguous switch request; sticky resolution is kept. */
      switchNotice?: PersonaSwitchNotice | undefined;
      /**
       * The invocation named the already-active persona: the turn still runs
       * under it, but no new activation row is written.
       */
      skipActivationWrite?: boolean | undefined;
    }
  | {
      kind: 'default';
      source: Extract<PersonaActivationSource, 'default'>;
      selection: 'semantic' | 'direct';
      /** Model-visible notice for an ambiguous switch request; the default assistant answers. */
      switchNotice?: PersonaSwitchNotice | undefined;
      /**
       * The request landed on the already-active default assistant (direct
       * no-op, or an ambiguous request that fails closed): no activation row
       * is recorded, since the user did not choose the default.
       */
      skipActivationWrite?: boolean | undefined;
    };

/**
 * The user-authored text of each user message in the turn, with file parts
 * dropped, in order.
 *
 * Trust boundary: ONLY `type === 'user.message'` items are scanned for
 * persona invocations. Server tool results (`user.tool_response`) and other
 * input shapes never enter turn input, so a "switch to Zara" inside a tool
 * result cannot change the speaker. Each message is validated independently:
 * the invocation grammar is start-anchored, so a switch request in a queued
 * follow-up message would never match a concatenation, and concatenation
 * would corrupt the validator's per-message clause semantics (quotes, fences).
 */
function turnInvocationTexts(input: TurnInputItem[] | undefined): string[] {
  const texts: string[] = [];
  for (const item of input ?? []) {
    if (!isAgentInputUserMessage(item)) {
      continue;
    }
    const text =
      typeof item.content === 'string'
        ? item.content
        : item.content
            .filter(part => !isFileContentPart(part))
            .map(part => part.text)
            .join(' ');
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      texts.push(trimmed);
    }
  }
  return texts;
}

/**
 * The default assistant as a target for the deterministic invocation grammar:
 * the configured assistant name plus the literal "default". A name that also
 * names a configured persona is dropped — the persona wins, matching the
 * validator's collision rule.
 */
function defaultAssistantInvocationContent(input: {
  defaultAssistantName: string | null | undefined;
  personas: Persona[];
}): PersonaContent | undefined {
  const personaKeys = new Set(input.personas.flatMap(persona => personaNameKeys(persona)));
  const names: string[] = [];
  for (const candidate of [input.defaultAssistantName, 'default']) {
    if (candidate === null || candidate === undefined) {
      continue;
    }
    const key = personaMatchKey(candidate);
    if (key.length === 0 || personaKeys.has(key) || names.some(name => personaMatchKey(name) === key)) {
      continue;
    }
    names.push(candidate.trim().replace(/\s+/g, ' '));
  }
  const [displayName, ...aliases] = names;
  if (displayName === undefined) {
    return undefined;
  }
  return { display_name: displayName, aliases, instructions: '', model_name: '' };
}

/**
 * The candidates of a genuine but ambiguous switch clause. Names are passed
 * through raw; PersonaTurnResourceResolver sanitizes at the model-visible
 * boundary. Ordering follows the candidates' order of mention in the message,
 * which is deterministic.
 */
function buildAmbiguousSwitchNotice(input: {
  candidateKeys: string[];
  personas: Persona[];
  defaultAssistantName: string | null | undefined;
}): PersonaSwitchNotice | undefined {
  const candidates = input.candidateKeys
    .map(key => {
      if (key === 'default') {
        return input.defaultAssistantName ?? 'the default assistant';
      }
      return input.personas.find(persona => `persona:${persona.id}` === key)?.display_name ?? '';
    })
    .filter(name => name.length > 0);
  if (candidates.length < 2) {
    return undefined;
  }
  return { kind: 'ambiguous', candidates };
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
 * Precedence, strongest first: a deterministic direct invocation (persona or
 * default assistant), then the persona this branch is already talking to.
 * Invocation is a zero-model-call grammar over names the user configured —
 * it never infers a persona from the topic, and an ambiguous request fails
 * closed with a notice instead of guessing.
 * With no personas configured the path costs one indexed read and the turn
 * behaves exactly as it did before personas existed.
 *
 * A sticky persona that has since been deleted resolves to the default
 * assistant. That is not a silent substitution: the user removed it.
 */
export async function resolveTurnPersona(input: {
  personaStore: IPersonaStore;
  modelProviderStore: IModelProviderStore;
  defaultAssistantName: string | null | undefined;
  tenant_id: string;
  created_by: string;
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

  const defaultContent = defaultAssistantInvocationContent({
    defaultAssistantName: input.defaultAssistantName,
    personas,
  });
  // Each user-authored message is scanned independently and the last message
  // with a successful unambiguous match wins: a later queued message is
  // conversational repair ("switch to Zara" then "switch to Milo"),
  // categorically different from single-message "switch to Zara or Milo"
  // ambiguity. Only a successful match replaces the pending invocation — a
  // later message that merely mentions a name never erases an earlier switch —
  // and a successful match clears any earlier ambiguity notice, because the
  // user resolved it themselves. An ambiguous message always (re)sets the
  // notice without touching the invocation, so the model hears the
  // clarification request even when a switch already happened.
  let invoked: { kind: 'persona'; persona: Persona } | { kind: 'default' } | undefined;
  let switchNotice: PersonaSwitchNotice | undefined;
  for (const text of turnInvocationTexts(input.turnInput)) {
    const personaMatch = matchPersonaInvocation({ text, personas });
    // Default-assistant names match only after a switch lead-in: addressing
    // the default assistant by name ("Mannie, I have a friend named Inez.")
    // is ordinary conversation, not a speaker change.
    const defaultMatch =
      defaultContent === undefined
        ? undefined
        : matchPersonaInvocation({ text, personas: [defaultContent], leadInOnly: true });
    if (personaMatch === undefined && defaultMatch === undefined) {
      continue;
    }
    const check = isUnambiguousDirectPersonaInvocation({
      message: text,
      target: personaMatch === undefined ? { kind: 'default' } : { kind: 'persona', persona: personaMatch.persona },
      defaultAssistantName: input.defaultAssistantName,
      personas,
    });
    if (check.ok) {
      invoked = personaMatch === undefined ? { kind: 'default' } : { kind: 'persona', persona: personaMatch.persona };
      switchNotice = undefined;
    } else if (check.reason === 'ambiguous' && check.candidateKeys !== undefined) {
      switchNotice = buildAmbiguousSwitchNotice({
        candidateKeys: check.candidateKeys,
        personas,
        defaultAssistantName: input.defaultAssistantName,
      });
    }
  }

  const sticky = stickyPersona({ ...input, personas });
  let resolution:
    | {
        persona: Persona;
        source: 'invocation' | 'sticky';
        selection: 'direct' | 'semantic' | 'sticky';
        skipActivationWrite?: boolean | undefined;
      }
    | { source: 'default'; selection: 'semantic' | 'direct'; skipActivationWrite?: boolean | undefined }
    | undefined;
  if (invoked !== undefined) {
    // A switch to the already-active identity is a no-op: the turn still runs
    // under it, but no new activation row is written and no notice is needed.
    const alreadyActive = invoked.kind === 'persona' ? sticky?.persona.id === invoked.persona.id : sticky === undefined;
    resolution =
      invoked.kind === 'persona'
        ? {
            persona: invoked.persona,
            source: 'invocation',
            selection: 'direct',
            skipActivationWrite: alreadyActive || undefined,
          }
        : { source: 'default', selection: 'direct', skipActivationWrite: alreadyActive || undefined };
  } else {
    resolution = sticky;
  }
  if (resolution === undefined) {
    // An ambiguous request on a branch with no sticky persona still reaches
    // the model — the notice asks it to clarify, and the turn answers as the
    // default assistant. No activation is recorded: the user did not choose
    // the default, they are simply already on it.
    if (switchNotice === undefined) {
      return undefined;
    }
    return { kind: 'default', source: 'default', selection: 'semantic', switchNotice, skipActivationWrite: true };
  }

  if (!('persona' in resolution)) {
    return {
      kind: 'default',
      source: 'default',
      selection: resolution.selection,
      switchNotice,
      skipActivationWrite: resolution.skipActivationWrite,
    };
  }

  await assertPersonaModelAvailable({
    displayName: resolution.persona.display_name,
    modelName: resolution.persona.model_name,
    tenant_id: input.tenant_id,
    modelProviderStore: input.modelProviderStore,
  });
  return { kind: 'persona', ...resolution, context: buildPersonaContext(resolution.persona), switchNotice };
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
