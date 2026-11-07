/**
 * The Home Assistant connector: the person's own Home Assistant, reached through the Model
 * Context Protocol Server integration it serves. The name is the MCP server name the classifier
 * keys on, so only the connector the preset saved gets these rules.
 */
export const HOME_ASSISTANT_SERVER_NAME = 'home-assistant';

/** The one line a refused call says. Home Assistant keeps control of these itself, by design. */
export const HOME_ASSISTANT_REFUSAL = 'Aman does not control locks, alarms or garage doors. Do that in Home Assistant.';

/**
 * Home Assistant names a tool for the set it came from: newer servers prefix the tool with its
 * set (`intent__HassTurnOn`, `light__HassLightSet`), older ones serve the bare name. The tier
 * rules read the bare name, so the same rules hold on both.
 */
export function homeAssistantToolBase(tool_name: string): string {
  const split = tool_name.lastIndexOf('__');
  return split === -1 ? tool_name : tool_name.slice(split + 2);
}

/** The set a tool came from, when the server prefixed its name (`light` for `light__HassLightSet`). */
export function homeAssistantToolPrefix(tool_name: string): string | null {
  const split = tool_name.lastIndexOf('__');
  return split === -1 ? null : tool_name.slice(0, split);
}

/** The tools that only read the home. A tool the server marks read-only is a read too. */
export const HOME_ASSISTANT_READ_TOOL_NAMES = ['GetLiveContext', 'GetDateTime', 'HassGetState', 'get_items'] as const;

/** Whether the tool only reads the home: a listed read, or one the server marks read-only. */
export function isHomeAssistantReadTool(input: { tool_name: string; read_only_hint: boolean | undefined }): boolean {
  if (input.read_only_hint === true) {
    return true;
  }
  return (HOME_ASSISTANT_READ_TOOL_NAMES as readonly string[]).includes(homeAssistantToolBase(input.tool_name));
}

/** The live-context tool, under whatever prefix the server gave it. Connect checks count its entities. */
export function isHomeAssistantLiveContextTool(tool_name: string): boolean {
  return homeAssistantToolBase(tool_name) === 'GetLiveContext';
}

/**
 * Domains Aman never controls, whatever the person allows: the locks and alarm panels Home
 * Assistant itself keeps away from assistants unless the person exposes them by hand.
 */
export const HOME_ASSISTANT_REFUSED_DOMAINS = ['lock', 'alarm_control_panel'] as const;

/** Cover device classes that lead outside the home. A cover inside the home still asks first. */
export const HOME_ASSISTANT_REFUSED_COVER_DEVICE_CLASSES = ['garage', 'gate', 'door'] as const;

/** Words in a target's name that mark it as one of the refused kinds when nothing else names its domain. */
const REFUSED_NAME_PATTERN = /\b(lock|locks|alarm|garage)\b/i;

/** What a call acts on, read from the arguments Home Assistant's tools take. */
export interface HomeAssistantTarget {
  /** The entity the call names (`light.living_room_lamp`), or null when it names none. */
  entity_id: string | null;
  /** The plain name the call names (`Living room lamp`), or null when it names none. */
  name: string | null;
  /** The Home Assistant domain the call acts on, or null when the arguments do not say. */
  domain: string | null;
  /** The device class the call filters by, or null when it names none. */
  device_class: string | null;
}

function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function firstStringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  if (typeof value === 'string' && value !== '') {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && entry !== '') {
        return entry;
      }
    }
  }
  return null;
}

/** The domain an entity id belongs to: the part before the dot. */
export function homeAssistantDomainOfEntity(entity_id: string): string | null {
  const dot = entity_id.indexOf('.');
  return dot > 0 ? entity_id.slice(0, dot) : null;
}

/**
 * What a call acts on. Home Assistant's tools name their target by entity id, by plain name, or
 * by a domain or device class filter; the card and the tiers read whichever the call carries.
 */
export function homeAssistantTarget(input: {
  tool_name: string;
  params: Record<string, unknown>;
}): HomeAssistantTarget {
  const params = input.params;
  const entity_id = firstStringParam(params, 'entity_id');
  const name = stringParam(params, 'name');
  const device_class = firstStringParam(params, 'device_class');
  const fromEntity = entity_id === null ? null : homeAssistantDomainOfEntity(entity_id);
  const fromArgs = firstStringParam(params, 'domain');
  const prefix = homeAssistantToolPrefix(input.tool_name);
  // A tool set named for a domain (the light set, the climate set) acts on that domain.
  const fromPrefix = prefix === null || prefix === 'intent' || prefix === 'homeassistant' ? null : prefix;
  return {
    entity_id,
    name,
    domain: fromEntity ?? fromArgs ?? fromPrefix,
    device_class,
  };
}

/** Whether the call touches a lock, an alarm, a garage door or a cover that leads outside. */
export function isHomeAssistantRefusedTarget(target: HomeAssistantTarget): boolean {
  if (target.domain !== null && (HOME_ASSISTANT_REFUSED_DOMAINS as readonly string[]).includes(target.domain)) {
    return true;
  }
  if (
    target.domain === 'cover' &&
    target.device_class !== null &&
    (HOME_ASSISTANT_REFUSED_COVER_DEVICE_CLASSES as readonly string[]).includes(target.device_class)
  ) {
    return true;
  }
  // With no entity id and no domain to judge by, a name that says lock, alarm or garage is enough.
  if (target.domain === null && target.name !== null && REFUSED_NAME_PATTERN.test(target.name)) {
    return true;
  }
  return false;
}

/**
 * The key a standing grant for this call is stored under: the domain it acts on when that is
 * known, else the one entity. Null when the call names neither, so no standing grant is offered.
 */
export function homeAssistantGrantScopeKey(target: HomeAssistantTarget): string | null {
  if (target.domain !== null) {
    return `ha:domain:${target.domain}`;
  }
  if (target.entity_id !== null) {
    return `ha:entity:${target.entity_id}`;
  }
  if (target.name !== null) {
    return `ha:entity:${target.name.trim().toLowerCase()}`;
  }
  return null;
}

/** Every scope key a standing grant could cover this call under: its entity key and its domain key. */
export function homeAssistantGrantScopeKeys(target: HomeAssistantTarget): string[] {
  const keys: string[] = [];
  if (target.entity_id !== null) {
    keys.push(`ha:entity:${target.entity_id}`);
  } else if (target.name !== null) {
    keys.push(`ha:entity:${target.name.trim().toLowerCase()}`);
  }
  if (target.domain !== null) {
    keys.push(`ha:domain:${target.domain}`);
  }
  return keys;
}

/** An entity id as a person says it: `light.living_room_lamp` becomes `Living room lamp`. */
export function homeAssistantEntityLabel(entity_id: string): string {
  const object = entity_id.slice(entity_id.indexOf('.') + 1).replace(/_/g, ' ').trim();
  return object === '' ? entity_id : object.charAt(0).toUpperCase() + object.slice(1);
}

/** The name the card shows for a target: the call's own name, else its entity in plain words. */
export function homeAssistantTargetLabel(target: HomeAssistantTarget): string | null {
  if (target.name !== null) {
    return target.name;
  }
  if (target.entity_id !== null) {
    return homeAssistantEntityLabel(target.entity_id);
  }
  return null;
}

/** Domain names as a person says them, for the Settings list of standing grants. */
const HOME_ASSISTANT_DOMAIN_LABELS: Record<string, string> = {
  light: 'Lights',
  switch: 'Switches',
  climate: 'Heating and cooling',
  media_player: 'Media players',
  cover: 'Covers',
  fan: 'Fans',
  scene: 'Scenes',
  script: 'Scripts',
  lock: 'Locks',
  alarm_control_panel: 'Alarm panels',
  sensor: 'Sensors',
  binary_sensor: 'Sensors',
  vacuum: 'Vacuums',
  humidifier: 'Humidifiers',
  water_heater: 'Water heaters',
  todo: 'Lists',
  button: 'Buttons',
  input_boolean: 'Switches',
};

/** A standing grant's scope key in plain words: what it covers, for Settings. */
export function homeAssistantGrantLabel(scope_key: string): string | null {
  if (scope_key.startsWith('ha:domain:')) {
    const domain = scope_key.slice('ha:domain:'.length);
    return `All ${HOME_ASSISTANT_DOMAIN_LABELS[domain] ?? domain.replace(/_/g, ' ')}`;
  }
  if (scope_key.startsWith('ha:entity:')) {
    const entity = scope_key.slice('ha:entity:'.length);
    return entity.includes('.') ? homeAssistantEntityLabel(entity) : entity;
  }
  return null;
}
