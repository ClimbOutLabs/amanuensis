import type { ResolvedAgentDefinition } from '@truefoundry/trueforge-core/agent-session';
import type { AgentCapability, ModelMessageEvent } from '@truefoundry/trueforge-core/core';
import type { PersonalizationProfile } from '../personalization/profile';
import type { PersonaContext } from '../personas/persona';
import { repairAssistantMessageContent, stripCitationMarkers } from '../personaKnowledge/knowledgeAttribution';
import type { PersonaKnowledgeHit } from '../personaKnowledge/knowledgeRetrieval';
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

/** Root-only capability: retrieved passages from the active persona's knowledge library. */
function personaKnowledgeCapability(block: string): AgentCapability {
  return {
    instructionBuilders: [
      builder => {
        builder.addSection('persona-knowledge', block, true);
      },
    ],
  };
}

/** Root-only: tells the model a switch request was ambiguous so it can ask which persona was meant. */
export interface PersonaSwitchNotice { kind: 'ambiguous'; candidates: string[] }

const MAX_SWITCH_NOTICE_NAME_CHARACTERS = 120;

/**
 * Names echoed into the notice are configured or user-authored, but the
 * notice is a model-visible prompt section: strip control characters and cap
 * length here, at the boundary, so a hostile display name cannot smuggle
 * prompt structure or newlines past it.
 */
function sanitizeSwitchNoticeName(name: string): string {
  return name.replace(/[\p{C}]/gu, '').slice(0, MAX_SWITCH_NOTICE_NAME_CHARACTERS).trim();
}

/** Renders the notice; undefined when sanitization leaves nothing to say. */
function renderSwitchNotice(notice: PersonaSwitchNotice): string | undefined {
  const names = notice.candidates.map(sanitizeSwitchNoticeName).filter(name => name.length > 0);
  if (names.length < 2) {
    return undefined;
  }
  const quoted = names.map(name => `'${name}'`);
  const joined =
    quoted.length === 2
      ? `${String(quoted[0])} and ${String(quoted[1])}`
      : `${quoted.slice(0, -1).join(', ')}, and ${String(quoted[quoted.length - 1])}`;
  const verb = quoted.length === 2 ? 'both match' : 'all match';
  return `The user asked to switch to a persona, but ${joined} ${verb}. Ask them, briefly, which one they meant, and continue as the current persona.`;
}

function switchNoticeCapability(notice: PersonaSwitchNotice): AgentCapability {
  return {
    instructionBuilders: [
      builder => {
        const rendered = renderSwitchNotice(notice);
        if (rendered !== undefined) {
          builder.addSection('persona-switch-notice', rendered, true);
        }
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
  readonly #personaKnowledgeBlock: string | undefined;
  /**
   * Host post-pass: enforces knowledge attribution on the root thread's
   * final assistant message. Present only when the turn injected passages;
   * the harness applies it once, before the terminal state is persisted.
   */
  readonly finalizeAssistantOutput:
    | ((output: ModelMessageEvent) => ModelMessageEvent | undefined)
    | undefined;
  /**
   * Host marker strip for the durable thread context: persona turns never
   * persist live citation markers, so a stale marker in history cannot
   * false-attribute a passage in a later turn. Set for every persona turn —
   * it is a no-op when the answer carries no markers.
   */
  readonly sanitizeAssistantTextForContext: ((text: string) => string) | undefined;
  readonly #switchNotice: PersonaSwitchNotice | undefined;

  constructor(
    deps: ConstructorParameters<typeof PersonalizationTurnResourceResolver>[0],
    profile: PersonalizationProfile | undefined,
    persona: PersonaContext | undefined,
    personaKnowledgeBlock?: string,
    personaKnowledgeHits?: readonly PersonaKnowledgeHit[],
    switchNotice?: PersonaSwitchNotice,
  ) {
    // The configured persona owns assistant identity and voice while active, so
    // the deployment personalization is projected without its identity fields
    // whenever a persona context is present. The presence of the persona — not a
    // caller-supplied flag — decides this once per turn, so a thin persona
    // definition can never lose to the deployment identity through a forgotten
    // or mis-set option.
    super(deps, profile, { speaker: persona === undefined ? 'default_assistant' : 'persona' });
    this.#persona = persona;
    this.#personaKnowledgeBlock = personaKnowledgeBlock;
    this.sanitizeAssistantTextForContext = stripCitationMarkers;
    this.finalizeAssistantOutput =
      personaKnowledgeHits === undefined || personaKnowledgeHits.length === 0
        ? undefined
        : output => {
            const repaired = repairAssistantMessageContent(output.content, personaKnowledgeHits);
            return repaired === output.content ? undefined : { ...output, content: repaired };
          };
    this.#switchNotice = switchNotice;
  }

  override async resolveAgentDefinition(
    input: Parameters<PersonalizationTurnResourceResolver['resolveAgentDefinition']>[0],
  ): Promise<ResolvedAgentDefinition> {
    const resolved = await super.resolveAgentDefinition(input);
    const persona = this.#persona;
    if (input.agent_info !== undefined) {
      return resolved;
    }
    const switchNotice = this.#switchNotice;
    if (persona === undefined) {
      return {
        ...resolved,
        extraCapabilities: [
          ...(resolved.extraCapabilities ?? []),
          defaultSpeakerContextCapability(),
          ...(switchNotice === undefined ? [] : [switchNoticeCapability(switchNotice)]),
        ],
      };
    }

    // Params travel with the model that was selected, as they do for the
    // delegation role: a temperature or reasoning effort tuned for the chat's
    // own model can be meaningless, or wrong, for the persona's.
    const personaModel = await this.deps.llm(persona.model_name);
    const knowledgeCapability =
      this.#personaKnowledgeBlock === undefined ? [] : [personaKnowledgeCapability(this.#personaKnowledgeBlock)];

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
      extraCapabilities: [
        ...(resolved.extraCapabilities ?? []),
        personaContextCapability(persona),
        ...knowledgeCapability,
        ...(this.#switchNotice === undefined ? [] : [switchNoticeCapability(this.#switchNotice)]),
      ],
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
