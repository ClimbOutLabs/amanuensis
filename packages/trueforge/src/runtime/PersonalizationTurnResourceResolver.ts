import { TurnResourceResolver } from '@truefoundry/trueforge-core/agent-session';
import type { AgentCapability } from '@truefoundry/trueforge-core/core';
import type { TurnCustom } from '../db/sessionCustom';
import {
  buildPersonalizationContext,
  type PersonalizationContext,
  type PersonalizationProfile,
  type PersonalizationSpeaker,
} from '../personalization/profile';
import { personalizationContextCapability } from './personalizationContext';

export function personalizationCapabilitiesForTurn(
  context: PersonalizationContext | undefined,
  isSubAgent: boolean,
): AgentCapability[] {
  if (!context || isSubAgent) {
    return [];
  }
  return [personalizationContextCapability(context)];
}

/**
 * Adds one immutable per-turn profile context to root agents only.
 *
 * The speaker is a resolved constructor value, decided once where both inputs
 * are known (a subclass that owns persona state passes `persona`; the base is
 * the default assistant). There is no projection hook to override, so a future
 * subclass cannot silently inherit a wrong speaker.
 */
export class PersonalizationTurnResourceResolver extends TurnResourceResolver<TurnCustom> {
  readonly #profile: PersonalizationProfile | undefined;
  readonly #speaker: PersonalizationSpeaker;
  #context: PersonalizationContext | undefined;
  #contextRendered = false;

  constructor(
    deps: ConstructorParameters<typeof TurnResourceResolver<TurnCustom>>[0],
    profile: PersonalizationProfile | undefined,
    options: { speaker: PersonalizationSpeaker },
  ) {
    super(deps);
    this.#profile = profile;
    this.#speaker = options.speaker;
  }

  /**
   * Renders the profile for this turn; undefined when no profile is configured.
   * Memoized: the profile is immutable for the turn, so repeated resolutions
   * (root plus any delegated turns) render it at most once.
   */
  protected personalizationContext(): PersonalizationContext | undefined {
    if (!this.#contextRendered) {
      this.#contextRendered = true;
      this.#context =
        this.#profile === undefined
          ? undefined
          : buildPersonalizationContext(this.#profile, { speaker: this.#speaker });
    }
    return this.#context;
  }

  override async resolveAgentDefinition(input: Parameters<TurnResourceResolver['resolveAgentDefinition']>[0]) {
    const resolved = await super.resolveAgentDefinition(input);
    // Sub-agent threads get no personalization at all, so skip the render:
    // resolving a delegation thread must not pay for a context it discards.
    if (input.agent_info !== undefined) {
      return resolved;
    }
    // Sub-agent threads are handled above, so the render here always serves the root thread.
    const personalizationCapabilities = personalizationCapabilitiesForTurn(this.personalizationContext(), false);
    if (personalizationCapabilities.length === 0) {
      return resolved;
    }
    return {
      ...resolved,
      extraCapabilities: [...(resolved.extraCapabilities ?? []), ...personalizationCapabilities],
    };
  }
}
