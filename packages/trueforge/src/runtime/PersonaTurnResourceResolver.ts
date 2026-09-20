import type { ResolvedAgentDefinition } from '@truefoundry/trueforge-core/agent-session';
import type { AgentCapability } from '@truefoundry/trueforge-core/core';
import type { PersonalizationContext } from '../personalization/profile';
import type { PersonaContext } from '../personas/persona';
import { PersonalizationTurnResourceResolver } from './PersonalizationTurnResourceResolver';

/** Root-only capability: the persona is who is answering the user, not who runs a sub-agent. */
function personaContextCapability(context: PersonaContext): AgentCapability {
  return {
    instructionBuilders: [
      builder => {
        builder.addSection('persona-context', context.injected_context, true);
      },
    ],
  };
}

/** Root-only guard for returning from a persona to the chat's default assistant. */
function defaultSpeakerContextCapability(): AgentCapability {
  return {
    instructionBuilders: [
      builder => {
        builder.addSection(
          'active-speaker-context',
          'The default assistant is the only active assistant identity for this turn. Earlier assistant messages may have been written by other configured speakers. Use them for conversational continuity and factual context only. Do not imitate their identity, voice, formatting, metaphors, or behavioral style.',
          true,
        );
      },
    ],
  };
}

/**
 * Applies the active persona to the root thread of one turn.
 *
 * Switching personas mid-conversation needs no plumbing through the LLM layer:
 * `SessionHandle.buildThreads` constructs a fresh `AgentThread` per turn and
 * resolves its model here, while the conversation itself lives in the session
 * store. So this replaces the model client for this turn only, and the shared
 * history carries over untouched. Nothing about `spec.model` is written.
 *
 * Sub-agent threads are left alone: they belong to the delegation role, not to
 * whoever the user is currently talking to.
 */
export class PersonaTurnResourceResolver extends PersonalizationTurnResourceResolver {
  readonly #persona: PersonaContext | undefined;

  constructor(
    deps: ConstructorParameters<typeof PersonalizationTurnResourceResolver>[0],
    personalization: PersonalizationContext | undefined,
    persona: PersonaContext | undefined,
  ) {
    super(deps, personalization);
    this.#persona = persona;
  }

  override async resolveAgentDefinition(
    input: Parameters<PersonalizationTurnResourceResolver['resolveAgentDefinition']>[0],
  ): Promise<ResolvedAgentDefinition> {
    const resolved = await super.resolveAgentDefinition(input);
    const persona = this.#persona;
    if (input.agent_info !== undefined) {
      return resolved;
    }
    if (persona === undefined) {
      return {
        ...resolved,
        extraCapabilities: [...(resolved.extraCapabilities ?? []), defaultSpeakerContextCapability()],
      };
    }

    // Params travel with the model that was selected, as they do for the
    // delegation role: a temperature or reasoning effort tuned for the chat's
    // own model can be meaningless, or wrong, for the persona's.
    const personaModel = await this.deps.llm(persona.model_name);

    return {
      ...resolved,
      definition: {
        ...resolved.definition,
        modelClient: personaModel.modelClient,
        modelParams: { ...personaModel.defaultModelParams },
        // The identity prompt must name the persona's model, not the chat's. Fall back to the
        // catalog name without its provider prefix, as the base resolver does.
        modelId: personaModel.modelId ?? persona.model_name.slice(persona.model_name.indexOf('/') + 1),
        modelSupportsVision: personaModel.modelSupportsVision,
      },
      compactionModel: await this.#pinCompactionAwayFromPersona(input.spec, resolved),
      extraCapabilities: [...(resolved.extraCapabilities ?? []), personaContextCapability(persona)],
    };
  }

  /**
   * Compaction follows the compaction role or the chat's own model — never the
   * persona.
   *
   * With no compaction role set, `super` leaves `compactionModel` undefined so
   * the capability inherits `definition.modelClient`, which the persona has
   * just replaced. Summarization for the whole thread must not move to a small
   * persona model for the few turns that persona is active: a bad summary
   * degrades every later turn, far from its cause.
   */
  async #pinCompactionAwayFromPersona(
    spec: Parameters<PersonalizationTurnResourceResolver['resolveAgentDefinition']>[0]['spec'],
    resolved: ResolvedAgentDefinition,
  ): Promise<ResolvedAgentDefinition['compactionModel']> {
    if (resolved.compactionModel !== undefined || !spec.config.context_management.compaction.enabled) {
      return resolved.compactionModel;
    }
    const chatModel = await this.deps.llm(spec.model.name);
    return {
      modelClient: chatModel.modelClient,
      modelParams: { ...chatModel.defaultModelParams, ...spec.model.params },
    };
  }
}
