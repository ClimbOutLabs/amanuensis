/**
 * Checking a tool call's arguments against the tool's own schema before the call is sent.
 *
 * Self-hosted models regularly send arguments a strict tool cannot take: a boolean as the text
 * "true", an argument the tool does not have, a nested block with one wrong field. Sent on, those
 * calls fail inside the provider or the tool with raw validation text, or worse, run half-formed.
 * This check repairs what is safe to repair (boolean text to a real boolean, an argument the
 * schema does not name is dropped, an explicit null for an optional argument is dropped) and
 * reports the rest as plain problems the model can act on. It never sees, and never repeats, a
 * provider's own validation wording.
 */

/** The part of a JSON schema this check reads. Read from offered tool definitions by toParameterSchema. */
export interface ToolParameterSchema {
  type?: string | string[] | undefined;
  properties?: Record<string, ToolParameterSchema> | undefined;
  required?: string[] | undefined;
  items?: ToolParameterSchema | undefined;
  enum?: unknown[] | undefined;
  anyOf?: ToolParameterSchema[] | undefined;
  oneOf?: ToolParameterSchema[] | undefined;
  additionalProperties?: boolean | ToolParameterSchema | undefined;
}

/** One argument that could not be repaired: where it is, and what it should be, in plain words. */
export interface ArgumentProblem {
  path: string;
  expected: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSchema(value: unknown): ToolParameterSchema | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type =
    typeof value['type'] === 'string'
      ? value['type']
      : Array.isArray(value['type']) && value['type'].every(entry => typeof entry === 'string')
        ? value['type']
        : undefined;
  const properties = isRecord(value['properties'])
    ? Object.fromEntries(
        Object.entries(value['properties']).flatMap(([key, entry]) => {
          const schema = readSchema(entry);
          return schema === undefined ? [] : [[key, schema] as const];
        }),
      )
    : undefined;
  const required = Array.isArray(value['required'])
    ? value['required'].filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const items = readSchema(value['items']);
  const enumValues = Array.isArray(value['enum']) ? value['enum'] : undefined;
  const anyOf = Array.isArray(value['anyOf'])
    ? value['anyOf'].map(entry => readSchema(entry)).filter((entry): entry is ToolParameterSchema => entry !== undefined)
    : undefined;
  const oneOf = Array.isArray(value['oneOf'])
    ? value['oneOf'].map(entry => readSchema(entry)).filter((entry): entry is ToolParameterSchema => entry !== undefined)
    : undefined;
  const additional = value['additionalProperties'];
  const additionalProperties =
    typeof additional === 'boolean' ? additional : isRecord(additional) ? readSchema(additional) : undefined;
  return {
    ...(type !== undefined ? { type } : {}),
    ...(properties !== undefined ? { properties } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(items !== undefined ? { items } : {}),
    ...(enumValues !== undefined ? { enum: enumValues } : {}),
    ...(anyOf !== undefined && anyOf.length > 0 ? { anyOf } : {}),
    ...(oneOf !== undefined && oneOf.length > 0 ? { oneOf } : {}),
    ...(additionalProperties !== undefined ? { additionalProperties } : {}),
  };
}

/** Reads one offered tool's parameters (an unknown-shaped record) as a parameter schema. */
export function toParameterSchema(parameters: Record<string, unknown> | undefined): ToolParameterSchema {
  return readSchema(parameters) ?? {};
}

function describeSchema(schema: ToolParameterSchema): string {
  const union = schema.anyOf ?? schema.oneOf;
  if (union !== undefined && union.length > 0) {
    return union.map(member => describeSchema(member)).join(' or ');
  }
  if (schema.enum !== undefined && schema.enum.length > 0) {
    const shown = schema.enum.slice(0, 5).map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry)));
    return `one of: ${shown.join(', ')}`;
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  const named = types
    .map(entry =>
      entry === 'boolean'
        ? 'true or false'
        : entry === 'string'
          ? 'text'
          : entry === 'number' || entry === 'integer'
            ? 'a number'
            : entry === 'array'
              ? 'a list'
              : entry === 'object'
                ? 'an object with named fields'
                : entry === 'null'
                  ? 'nothing (null)'
                  : entry,
    )
    .filter(entry => entry !== '');
  return named.length > 0 ? named.join(' or ') : 'a valid value';
}

function valueMatchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

interface CheckOutcome {
  value: unknown;
  problems: ArgumentProblem[];
}

function joinPath(base: string, key: string): string {
  return base === '' ? key : `${base}.${key}`;
}

/**
 * Checks one value against one schema node, repairing what is safe: boolean text becomes a real
 * boolean, and inside an object that names its fields, entries the schema does not name are
 * dropped and an explicit null for an optional field is dropped. A value that still does not fit
 * comes back unchanged with a problem naming the field and what it should be.
 */
function checkValue(input: { schema: ToolParameterSchema; value: unknown; path: string }): CheckOutcome {
  const { schema, value, path } = input;

  const union = schema.anyOf ?? schema.oneOf;
  if (union !== undefined && union.length > 0) {
    // An exact fit wins; only then is a repaired fit used, so a repair in one member is never
    // preferred over a value that already fits another member unchanged.
    let repaired: CheckOutcome | undefined;
    for (const member of union) {
      const outcome = checkValue({ schema: member, value, path });
      if (outcome.problems.length > 0) {
        continue;
      }
      if (JSON.stringify(outcome.value) === JSON.stringify(value)) {
        return outcome;
      }
      repaired ??= outcome;
    }
    return repaired ?? { value, problems: [{ path, expected: describeSchema(schema) }] };
  }

  if (schema.enum !== undefined && schema.enum.length > 0) {
    const hit = schema.enum.some(entry => JSON.stringify(entry) === JSON.stringify(value));
    return hit ? { value, problems: [] } : { value, problems: [{ path, expected: describeSchema(schema) }] };
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (types.length === 0) {
    // No shape declared: only nested structure can still be checked.
    if (isRecord(value) && schema.properties !== undefined) {
      return checkObject({ schema, value, path });
    }
    return { value, problems: [] };
  }
  if (types.length > 1) {
    const asUnion: ToolParameterSchema = { anyOf: types.map(type => ({ type })) };
    return checkValue({ schema: asUnion, value, path });
  }
  const type = types[0] ?? '';

  if (!valueMatchesType(type, value)) {
    if (type === 'boolean' && typeof value === 'string') {
      const text = value.trim().toLowerCase();
      if (text === 'true' || text === 'false') {
        return { value: text === 'true', problems: [] };
      }
    }
    return { value, problems: [{ path, expected: describeSchema(schema) }] };
  }
  if (type === 'object' && isRecord(value)) {
    return checkObject({ schema, value, path });
  }
  if (type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    const problems: ArgumentProblem[] = [];
    const items = value.map((entry, index) => {
      const outcome = checkValue({ schema: schema.items ?? {}, value: entry, path: `${path}[${String(index)}]` });
      problems.push(...outcome.problems);
      return outcome.value;
    });
    return { value: items, problems };
  }
  return { value, problems: [] };
}

function checkObject(input: { schema: ToolParameterSchema; value: Record<string, unknown>; path: string }): CheckOutcome {
  const { schema, value, path } = input;
  const properties = schema.properties ?? {};
  const propertyNames = Object.keys(properties);
  const required = new Set(schema.required ?? []);
  const cleaned: Record<string, unknown> = {};
  const problems: ArgumentProblem[] = [];

  // A schema that names no properties declares a free-form object: nothing to check or drop.
  // Dropping by a required list alone could silently remove the very argument the tool needs.
  if (propertyNames.length === 0) {
    return { value, problems: [] };
  }

  for (const [key, entry] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (propertySchema === undefined) {
      if (schema.additionalProperties === true) {
        cleaned[key] = entry;
      } else if (isRecord(schema.additionalProperties)) {
        const outcome = checkValue({ schema: schema.additionalProperties, value: entry, path: joinPath(path, key) });
        problems.push(...outcome.problems);
        if (outcome.problems.length === 0) {
          cleaned[key] = outcome.value;
        }
      }
      // Named-fields schema with no allowance for extras: the entry is dropped, not sent.
      continue;
    }
    if (entry === null && !required.has(key)) {
      // An explicit null for an optional argument means "not given": drop it, do not send it.
      continue;
    }
    const outcome = checkValue({ schema: propertySchema, value: entry, path: joinPath(path, key) });
    problems.push(...outcome.problems);
    cleaned[key] = outcome.value;
  }
  for (const name of required) {
    if (!(name in cleaned) && !(name in value)) {
      problems.push({ path: joinPath(path, name), expected: `${describeSchema(properties[name] ?? {})} (this one is required)` });
    }
  }
  return { value: cleaned, problems };
}

/**
 * Checks a whole call's arguments. Returns the arguments to send (repaired and pruned) and the
 * problems that could not be repaired. A call with problems must not be sent; the problems are
 * the model's instructions for its one retry.
 */
export function checkToolArguments(input: {
  schema: ToolParameterSchema;
  args: Record<string, unknown>;
}): { args: Record<string, unknown>; problems: ArgumentProblem[] } {
  const outcome = checkObject({ schema: input.schema, value: input.args, path: '' });
  return { args: isRecord(outcome.value) ? outcome.value : input.args, problems: outcome.problems };
}

/** The plain message the model gets when its call was not sent: what is wrong and what it should be. */
export function toolArgumentProblemMessage(input: { toolName: string; problems: ArgumentProblem[] }): string {
  const parts = input.problems.map(problem => `${problem.path} should be ${problem.expected}`);
  return (
    `The ${input.toolName} call was not sent because some of its arguments were wrong, so nothing was done with it. ` +
    `Fix these and try once more: ${parts.join('; ')}.`
  );
}
