import {
  HOME_ASSISTANT_REFUSAL,
  HOME_ASSISTANT_SERVER_NAME,
  homeAssistantDomainLabel,
  homeAssistantDomainsLabel,
  homeAssistantGrantCoverage,
  homeAssistantGrantScopeKey,
  homeAssistantTarget,
  homeAssistantTargetLabel,
  homeAssistantToolBase,
  isHomeAssistantCallActionTool,
  isHomeAssistantKnownChangeTool,
  isHomeAssistantNameOnlyTarget,
  isHomeAssistantReadTool,
  isHomeAssistantRefusedTarget,
  type HomeAssistantTarget,
} from '../homeassistant/toolContract';
import { simpleCardCopy } from './cardCopy';
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
 * Reads run. A change asks, with the entity named on the card, unless standing grants cover
 * every target it names: each entity by a grant for that entity or its domain, and each further
 * domain by a grant for that domain. Locks, alarm panels, garage doors and covers that lead outside are
 * refused outright, with no standing grant possible. The generic action tool is refused
 * outright too: it can run any service and names its target where these rules cannot read it.
 * A write tool Aman does not know asks every time, with no standing grant possible. A change
 * that read content steered is refused too, as a steered send is.
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

  // The generic action tool is refused before anything else, reads included: it can run a
  // lock, alarm or garage service while naming its target inside arguments these rules
  // cannot judge, so no card and no grant may carry it.
  if (isHomeAssistantCallActionTool(action.tool_name)) {
    return autoDenyDecision({
      reason: 'home_assistant_refused',
      reason_detail: HOME_ASSISTANT_REFUSAL,
      owner_message: HOME_ASSISTANT_REFUSAL,
      sensitive_read: false,
    });
  }

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

  // Standing grants cover only the change tools Aman knows. A write tool outside that set
  // asks every time, and its card offers no grant to record.
  const known_change = isHomeAssistantKnownChangeTool(action.tool_name);
  const coverage = known_change ? homeAssistantGrantCoverage(target) : [];
  if (coverage.length > 0) {
    const covering: string[] = [];
    let every_target_covered = true;
    for (const group of coverage) {
      let matched: string | null = null;
      for (const scope_key of group) {
        if (await hasStandingGrant(scope_key)) {
          matched = scope_key;
          break;
        }
      }
      if (matched === null) {
        every_target_covered = false;
        break;
      }
      covering.push(matched);
    }
    if (every_target_covered) {
      return tier1Decision({
        reason: TOOL_GRANT_REASON,
        reason_detail: `Always allowed: changes like this in Home Assistant (${covering.join(', ')}).`,
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
    grant_tool_name: known_change ? homeAssistantGrantScopeKey(target) : null,
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
  const plain_what = plainWhatFor({ tool_name, params, target });
  return {
    plain_what,
    copy: simpleCardCopy({ headline: plain_what, undo: null, reason: null }),
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
  const headline = headlineFor({ tool_name, params, target });
  // A call that names only a plain name gives Aman nothing to judge the device by: the card
  // says so, rather than letting a name read as a kind.
  if (isHomeAssistantNameOnlyTarget(target)) {
    return `${headline}. Aman could not tell what kind of device this is`;
  }
  return headline;
}

function headlineFor({
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
  const named = label === null ? null : escapeDisplayText(label);
  // With no name or entity to show, the card names the area or floor and the domain instead,
  // so the person can still tell what the call would act on.
  const shown = named ?? areaTargetPhrase(target);
  if (base === 'HassTurnOn') {
    if (target.domain === 'scene' && named !== null) {
      return `Run the ${named} scene`;
    }
    if (target.domain === 'script' && named !== null) {
      return `Run ${named}`;
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

/**
 * What a call acts on when it names no device: the domain in plain words, with the area or
 * floor it is scoped to (`the covers in the Garage`). Null when it names none of those either.
 */
/**
 * What a call acts on when it names no device: the domains in plain words, with the area or
 * floor it is scoped to (`the covers in the Garage`), or every domain when it names several.
 * Null when it names none of those either.
 */
function areaTargetPhrase(target: HomeAssistantTarget): string | null {
  const where =
    target.area !== null
      ? ` in the ${escapeDisplayText(target.area)}`
      : target.floor !== null
        ? ` on the ${escapeDisplayText(target.floor)}`
        : '';
  // A call that names several domains says them all, not only the first.
  const many = homeAssistantDomainsLabel(target.domains);
  if (many !== null) {
    return `${many}${where}`;
  }
  const label = target.domain === null ? null : homeAssistantDomainLabel(target.domain);
  const words = label === null ? null : label.charAt(0).toLowerCase() + label.slice(1);
  if (where !== '') {
    return words === null ? `everything${where}` : `the ${words}${where}`;
  }
  return words === null ? null : `the ${words}`;
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
