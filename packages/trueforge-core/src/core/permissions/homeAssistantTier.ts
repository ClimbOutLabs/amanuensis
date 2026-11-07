import {
  HOME_ASSISTANT_REFUSAL,
  HOME_ASSISTANT_SERVER_NAME,
  homeAssistantGrantScopeKey,
  homeAssistantGrantScopeKeys,
  homeAssistantTarget,
  homeAssistantTargetLabel,
  homeAssistantToolBase,
  isHomeAssistantReadTool,
  isHomeAssistantRefusedTarget,
  type HomeAssistantTarget,
} from '../homeassistant/toolContract';
import type { SentinelAction } from './classifier';
import { escapeDisplayText } from './displayText';
import { renderOutboundArguments, SEND_VALUE_MAX_CHARS } from './extractorRegistry';
import { autoDenyDecision, tier1Decision, tier3Decision, type Tier3Card, type TierDecision } from './tier';
import { TOOL_GRANT_REASON } from './toolGrants';

/** Reason code for a Home Assistant read that runs without asking. */
export const HOME_ASSISTANT_READ_REASON = 'home_assistant_read';
/** Reason code for a Home Assistant change that waits for the person's OK. */
export const HOME_ASSISTANT_CHANGE_REASON = 'home_assistant_change';

/**
 * Tier rules for the Home Assistant connector, classified by tool name so the behaviour does not
 * depend on the model. Only the connector the preset saved gets them; any other server returns
 * undefined and the generic path asks (fail closed).
 *
 * Reads run. A change asks, with the entity named on the card, unless a standing grant covers its
 * domain or the one entity. Locks, alarm panels, garage doors and covers that lead outside are
 * refused outright, with no standing grant possible. A change that read content steered is
 * refused too, as a steered send is.
 */
export async function classifyHomeAssistantTool({
  action,
  mintToken,
  hasStandingGrant,
  steered,
  assistant,
}: {
  action: Pick<
    SentinelAction,
    'tool_name' | 'canonical_params' | 'tool_type' | 'mcp_server_name' | 'mcp_server_host' | 'mcp_hints'
  >;
  mintToken: () => Promise<string>;
  /** Whether a standing grant is stored under this scope key (`ha:domain:light`, `ha:entity:...`). */
  hasStandingGrant: (scope_key: string) => Promise<boolean>;
  /** Whether read content, not the person, chose this call's target. Judged by the classifier's provenance record. */
  steered: boolean;
  /** The assistant's display name, for the sentence that says who read the steering content. */
  assistant: string;
}): Promise<TierDecision | undefined> {
  if (action.tool_type !== 'mcp' || action.mcp_server_name !== HOME_ASSISTANT_SERVER_NAME) {
    return undefined;
  }
  const params = action.canonical_params;
  const target = homeAssistantTarget({ tool_name: action.tool_name, params });

  if (isHomeAssistantReadTool({ tool_name: action.tool_name, read_only_hint: action.mcp_hints.read_only_hint })) {
    return tier1Decision({
      reason: HOME_ASSISTANT_READ_REASON,
      reason_detail: `Read your home with \`${action.tool_name}\`.`,
      sensitive_read: true,
    });
  }

  if (isHomeAssistantRefusedTarget(target)) {
    return autoDenyDecision({
      reason: 'home_assistant_refused',
      reason_detail: HOME_ASSISTANT_REFUSAL,
      owner_message: HOME_ASSISTANT_REFUSAL,
      sensitive_read: false,
    });
  }

  if (steered) {
    return autoDenyDecision({
      reason: 'steered_by_content',
      reason_detail: `Something ${assistant} read asked for this change to your home, not you.`,
      owner_message: `One step was skipped, because something ${assistant} read asked for it, not you.`,
      sensitive_read: false,
    });
  }

  for (const scope_key of homeAssistantGrantScopeKeys(target)) {
    if (await hasStandingGrant(scope_key)) {
      return tier1Decision({
        reason: TOOL_GRANT_REASON,
        reason_detail: `Always allowed: changes like this in Home Assistant (${scope_key}).`,
        sensitive_read: false,
      });
    }
  }

  const card = cardFor({ tool_name: action.tool_name, params, target });
  // A call whose arguments would be cut short on the card gets the generic card instead.
  if (card === null) {
    return undefined;
  }
  return tier3Decision({
    card,
    reason: HOME_ASSISTANT_CHANGE_REASON,
    reason_detail: 'A change to your home asks first.',
    sensitive_read: false,
    approval_token_id: await mintToken(),
    grant_host: action.mcp_server_host ?? null,
    grant_tool_name: homeAssistantGrantScopeKey(target),
  });
}

/**
 * The card for a change: the action and the entity in plain words, with the exact arguments
 * below. Null when the arguments would be cut short, so a shorter card never stands in for a
 * longer call.
 */
function cardFor({
  tool_name,
  params,
  target,
}: {
  tool_name: string;
  params: Record<string, unknown>;
  target: HomeAssistantTarget;
}): Tier3Card | null {
  const outbound = renderOutboundArguments(params, { valueMaxChars: SEND_VALUE_MAX_CHARS });
  if (outbound.truncated) {
    return null;
  }
  return {
    plain_what: plainWhatFor({ tool_name, params, target }),
    plain_why: null,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: outbound.text,
    destination_host: null,
    outbound_truncated: false,
  };
}

/** The card's headline: what happens, and to what, the way a person would say it. */
function plainWhatFor({
  tool_name,
  params,
  target,
}: {
  tool_name: string;
  params: Record<string, unknown>;
  target: HomeAssistantTarget;
}): string {
  const base = homeAssistantToolBase(tool_name);
  const label = homeAssistantTargetLabel(target);
  const shown = label === null ? null : escapeDisplayText(label);
  if (base === 'HassTurnOn') {
    if (target.domain === 'scene' && shown !== null) {
      return `Run the ${shown} scene`;
    }
    if (target.domain === 'script' && shown !== null) {
      return `Run ${shown}`;
    }
    return shown === null ? 'Turn something on in Home Assistant' : `Turn on ${shown}`;
  }
  if (base === 'HassTurnOff') {
    return shown === null ? 'Turn something off in Home Assistant' : `Turn off ${shown}`;
  }
  if (base === 'HassClimateSetTemperature') {
    const temperature = numericParam(params, 'temperature');
    if (shown !== null && temperature !== null) {
      return `Set ${shown} to ${String(temperature)} degrees`;
    }
    return shown === null ? 'Set the temperature in Home Assistant' : `Set the temperature of ${shown}`;
  }
  if (base === 'HassLightSet') {
    return shown === null ? 'Change a light in Home Assistant' : `Set ${shown}`;
  }
  if (base === 'HassSetPosition') {
    const position = numericParam(params, 'position');
    if (shown !== null && position !== null) {
      return `Set ${shown} to ${String(position)} percent open`;
    }
    return shown === null ? 'Move a cover in Home Assistant' : `Set the position of ${shown}`;
  }
  if (base.startsWith('HassMedia')) {
    return shown === null ? 'Control a media player in Home Assistant' : `${mediaVerb(base)} ${shown}`;
  }
  return shown === null ? `Run ${base} in Home Assistant` : `Change ${shown} in Home Assistant`;
}

function mediaVerb(base: string): string {
  if (base.includes('Pause')) {
    return 'Pause';
  }
  if (base.includes('Volume')) {
    return 'Set the volume of';
  }
  if (base.includes('Mute')) {
    return 'Mute';
  }
  if (base.includes('Next')) {
    return 'Skip to the next track on';
  }
  return 'Play';
}

function numericParam(params: Record<string, unknown>, key: string): number | null {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
