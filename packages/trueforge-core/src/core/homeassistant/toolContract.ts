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
 * The generic action tool newer servers serve beside the intent tools. It runs any service,
 * naming the service and its target inside its own arguments, where the target rules cannot
 * read them: a lock unlock or an alarm disarm arrives looking like any other call.
 */
export function isHomeAssistantCallActionTool(tool_name: string): boolean {
  return homeAssistantToolBase(tool_name) === 'call_action';
}

/**
 * The change tools the server itself declares, from its own tool list: the bare names of the
 * tools whose metadata says they change things (readOnlyHint set to false on the tool). The
 * host captures this at connect time and stores it on the connector record; grant eligibility
 * reads the stored declaration, never a list Aman ships. A tool the server does not declare
 * this way is not in the set, so it asks every time and no standing grant covers it.
 */
export function homeAssistantDeclaredChangeTools(
  tools: readonly { name: string; annotations?: { readOnlyHint?: boolean | undefined } | undefined }[],
): string[] {
  const declared: string[] = [];
  for (const tool of tools) {
    if (tool.annotations?.readOnlyHint !== false) {
      continue;
    }
    const base = homeAssistantToolBase(tool.name);
    if (!declared.includes(base)) {
      declared.push(base);
    }
  }
  return declared;
}

/**
 * Whether a change tool is one the server declared at connect time, so a standing grant may
 * cover it. A write tool outside the stored declaration asks every time and no standing grant
 * covers it, because Aman cannot say in advance what it does.
 */
export function isHomeAssistantDeclaredChangeTool(input: {
  tool_name: string;
  declared_change_tools: readonly string[];
}): boolean {
  return input.declared_change_tools.includes(homeAssistantToolBase(input.tool_name));
}

/**
 * Domains Aman never controls, whatever the person allows: the locks and alarm panels Home
 * Assistant itself keeps away from assistants unless the person exposes them by hand.
 */
export const HOME_ASSISTANT_REFUSED_DOMAINS = ['lock', 'alarm_control_panel'] as const;

/** Cover device classes that lead outside the home. A cover inside the home still asks first. */
export const HOME_ASSISTANT_REFUSED_COVER_DEVICE_CLASSES = ['garage', 'gate', 'door'] as const;

/** Cover device classes that stay inside the home, so naming one settles what an area call acts on. */
export const HOME_ASSISTANT_INSIDE_COVER_DEVICE_CLASSES = [
  'awning',
  'blind',
  'curtain',
  'damper',
  'shade',
  'shutter',
  'window',
] as const;

/** Words in a target's name that mark it as one of the refused kinds when nothing else names its domain. */
const REFUSED_NAME_PATTERN = /\b(lock|locks|alarm|garage)\b/i;

/** Words that mark a cover as leading outside the home, in its name or its entity id. */
const REFUSED_COVER_PATTERN = /\b(garage|gate|door)\b/i;

/** What a call acts on, read from the arguments Home Assistant's tools take. */
export interface HomeAssistantTarget {
  /** The first entity the call names (`light.living_room_lamp`), or null when it names none. */
  entity_id: string | null;
  /** Every entity the call names, in the order the call names them. */
  entity_ids: string[];
  /** The plain name the call names (`Living room lamp`), or null when it names none. */
  name: string | null;
  /** The first Home Assistant domain the call acts on, or null when the arguments do not say. */
  domain: string | null;
  /** Every domain the call acts on: its entities' domains, its domain filters, its tool set. */
  domains: string[];
  /** The first device class the call filters by, or null when it names none. */
  device_class: string | null;
  /** Every device class the call filters by, in the order the call names them. */
  device_classes: string[];
  /** The area the call is scoped to, or null when it names none. An area is a target too. */
  area: string | null;
  /** The floor the call is scoped to, or null when it names none. A floor is a target too. */
  floor: string | null;
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

/** Every string a parameter carries, whether the call gives one value or a list of them. */
function stringListParam(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (typeof value === 'string' && value !== '') {
    return [value];
  }
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string' && entry !== '') {
        entries.push(entry);
      }
    }
    return entries;
  }
  return [];
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
  const entity_ids = stringListParam(params, 'entity_id');
  const entity_id = entity_ids[0] ?? null;
  const name = stringParam(params, 'name');
  const device_classes = stringListParam(params, 'device_class');
  const prefix = homeAssistantToolPrefix(input.tool_name);
  // A tool set named for a domain (the light set, the climate set) acts on that domain.
  const fromPrefix = prefix === null || prefix === 'intent' || prefix === 'homeassistant' ? null : prefix;
  // Every domain the call touches, in the order the older single-domain read preferred them:
  // an entity's own domain first, then the domain filters, then the tool set's domain. A call
  // that names two domains acts on both, so refusal and grants judge the whole list.
  const domains: string[] = [];
  const addDomain = (domain: string | null): void => {
    if (domain !== null && !domains.includes(domain)) {
      domains.push(domain);
    }
  };
  for (const id of entity_ids) {
    addDomain(homeAssistantDomainOfEntity(id));
  }
  for (const domain of stringListParam(params, 'domain')) {
    addDomain(domain);
  }
  addDomain(fromPrefix);
  return {
    entity_id,
    entity_ids,
    name,
    domain: domains[0] ?? null,
    domains,
    device_class: device_classes[0] ?? null,
    device_classes,
    area: firstStringParam(params, 'area'),
    floor: firstStringParam(params, 'floor'),
  };
}

/**
 * Whether the call names only a plain name: no entity id and no domain from any source. A name
 * is a label, not a kind, so Aman cannot tell what kind of device such a call acts on, and no
 * standing grant may cover it: a grant recorded for a name would cover every entity that
 * happens to carry that name.
 */
export function isHomeAssistantNameOnlyTarget(target: HomeAssistantTarget): boolean {
  return target.entity_id === null && target.domains.length === 0 && target.name !== null;
}

/** Whether the call touches a lock, an alarm, a garage door or a cover that leads outside. */
export function isHomeAssistantRefusedTarget(target: HomeAssistantTarget): boolean {
  // Any domain the call names counts, not just the first: a call that names a light and a lock
  // acts on the lock too, so a light grant or a light reading must never carry it through.
  if (target.domains.some(domain => (HOME_ASSISTANT_REFUSED_DOMAINS as readonly string[]).includes(domain))) {
    return true;
  }
  // An outside device class refuses whatever domains the call names, even none: a filter
  // asking for garage covers acts on garage covers, domain argument or not.
  if (
    target.device_classes.some(device_class =>
      (HOME_ASSISTANT_REFUSED_COVER_DEVICE_CLASSES as readonly string[]).includes(device_class),
    )
  ) {
    return true;
  }
  if (target.domains.includes('cover') && coverNamedOutside(target)) {
    return true;
  }
  // A call scoped to an area or a floor names no one device: it reaches whatever that place
  // holds, covers included, so it is refused unless something narrows it to what stays
  // inside: an inside device class, or a domain other than cover. Naming no domain at all
  // narrows nothing, so the rule holds for those calls too.
  if (
    (target.area !== null || target.floor !== null) &&
    target.entity_ids.length === 0 &&
    !target.device_classes.some(device_class =>
      (HOME_ASSISTANT_INSIDE_COVER_DEVICE_CLASSES as readonly string[]).includes(device_class),
    ) &&
    !target.domains.some(domain => domain !== 'cover')
  ) {
    return true;
  }
  // With no entity id and no domain to judge by, a name that says lock, alarm or garage is enough.
  if (target.domains.length === 0 && target.name !== null && REFUSED_NAME_PATTERN.test(target.name)) {
    return true;
  }
  return false;
}

/**
 * Whether a cover the call names leads outside the home, judged by the cover itself: its name,
 * or its entity id with its underscores read as words, says garage, gate or door. The outside
 * device classes are judged in the refusal itself, since they refuse whatever the domain is.
 */
function coverNamedOutside(target: HomeAssistantTarget): boolean {
  if (target.name !== null && REFUSED_COVER_PATTERN.test(target.name)) {
    return true;
  }
  // Entity ids join their words with underscores (`cover.garage_door`); read them as words.
  if (target.entity_ids.some(id => REFUSED_COVER_PATTERN.test(id.replace(/_/g, ' ')))) {
    return true;
  }
  return false;
}

/**
 * The key a standing grant for this call is stored under: the domain it acts on when that is
 * known, else the one entity, by its entity id. Null when the call names neither, so no standing
 * grant is offered. A plain name is never a key: a grant under a name would silently cover every
 * entity that happens to carry that name, where a grant under an entity id covers only that one.
 */
export function homeAssistantGrantScopeKey(target: HomeAssistantTarget): string | null {
  if (target.domain !== null) {
    return `ha:domain:${target.domain}`;
  }
  if (target.entity_id !== null) {
    return `ha:entity:${target.entity_id}`;
  }
  return null;
}

/**
 * What standing grants must cover for this call, as one group of scope keys per target the
 * call names. Any one key in a group covers that group: an entity is covered by a grant for
 * the entity itself or for its domain, and a domain the call names beyond its entities (a
 * domain filter, or the tool set's domain) is covered by a grant for that domain. A call runs
 * under standing grants only when every group is covered, so a grant for the first target
 * alone never carries the rest. Refusal is judged on every domain and device class before
 * this is ever consulted, so no grant here can carry a call that also names a refused domain
 * or class. A name-only call returns no groups at all, so no stored grant can run it without
 * asking.
 */
export function homeAssistantGrantCoverage(target: HomeAssistantTarget): string[][] {
  const groups: string[][] = [];
  const entity_domains = new Set<string>();
  for (const entity_id of target.entity_ids) {
    const keys = [`ha:entity:${entity_id}`];
    const domain = homeAssistantDomainOfEntity(entity_id);
    if (domain !== null) {
      entity_domains.add(domain);
      keys.push(`ha:domain:${domain}`);
    }
    if (!groups.some(group => group[0] === keys[0])) {
      groups.push(keys);
    }
  }
  for (const domain of target.domains) {
    if (!entity_domains.has(domain)) {
      groups.push([`ha:domain:${domain}`]);
    }
  }
  return groups;
}

/** An entity id as a person says it: `light.living_room_lamp` becomes `Living room lamp`. */
export function homeAssistantEntityLabel(entity_id: string): string {
  const object = entity_id
    .slice(entity_id.indexOf('.') + 1)
    .replace(/_/g, ' ')
    .trim();
  return object === '' ? entity_id : object.charAt(0).toUpperCase() + object.slice(1);
}

/**
 * The names the card shows for a call that names several entities: the call's own name when
 * it gives one, else every entity in plain words, shortened to the first two and a count of
 * the rest when it names more than three.
 */
export function homeAssistantTargetLabel(target: HomeAssistantTarget): string | null {
  if (target.name !== null) {
    return target.name;
  }
  if (target.entity_ids.length > 1) {
    const labels = target.entity_ids.map(id => homeAssistantEntityLabel(id));
    const [first, second] = labels;
    const last = labels[labels.length - 1];
    if (first === undefined || last === undefined) {
      return null;
    }
    if (labels.length > 3) {
      if (second === undefined) {
        return null;
      }
      return `${first}, ${second} and ${String(labels.length - 2)} more`;
    }
    return `${labels.slice(0, -1).join(', ')} and ${last}`;
  }
  if (target.entity_id !== null) {
    return homeAssistantEntityLabel(target.entity_id);
  }
  return null;
}

/**
 * The phrase for a call that names several domains: the first two domains in plain words and
 * a count of the rest when it names more than two. Null when it names fewer than two, or when
 * a domain has no plain name.
 */
export function homeAssistantDomainsLabel(domains: string[]): string | null {
  if (domains.length < 2) {
    return null;
  }
  const labels: string[] = [];
  for (const domain of domains) {
    const label = homeAssistantDomainLabel(domain);
    if (label === null) {
      return null;
    }
    labels.push(label.charAt(0).toLowerCase() + label.slice(1));
  }
  const [first, second] = labels;
  if (first === undefined || second === undefined) {
    return null;
  }
  if (labels.length > 2) {
    return `the ${first} and ${second} and ${String(labels.length - 2)} more`;
  }
  return `the ${first} and ${second}`;
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

/** A domain in plain words (`light` becomes `Lights`), or null when it has no plain name. */
export function homeAssistantDomainLabel(domain: string): string | null {
  return HOME_ASSISTANT_DOMAIN_LABELS[domain] ?? null;
}

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
