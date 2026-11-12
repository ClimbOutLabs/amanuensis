/**
 * Checking a tool call's arguments against the tool's own schema before the call is sent.
 *
 * Self-hosted models regularly send arguments a strict tool cannot take: a boolean as the text
 * "true", an argument the tool does not have, a nested block with one wrong field. Sent on, those
 * calls fail inside the provider or the tool with raw validation text, or worse, run half-formed.
 * This check repairs what is safe to repair (boolean text to a real boolean, a list sent as its JSON
 * text to the list, an argument the schema does not name is dropped, an explicit null for an optional
 * argument is dropped) and
 * reports the rest as plain problems the model can act on. For a read-only tool, an optional
 * true-or-false argument whose value cannot be repaired is dropped too, so the call runs. It
 * never sees, and never repeats, a provider's own validation wording.
 */
import type { RawToolCall } from '../llm/LLMTypes';
import { isRecord } from '../util/records';

/** The part of a JSON schema this check reads. Read from offered tool definitions by toParameterSchema. */
export interface ToolParameterSchema {
  type?: string | string[] | undefined;
  properties?: Record<string, ToolParameterSchema> | undefined;
  required?: string[] | undefined;
  items?: ToolParameterSchema | undefined;
  enum?: unknown[] | undefined;
  anyOf?: ToolParameterSchema[] | undefined;
  oneOf?: ToolParameterSchema[] | undefined;
  allOf?: ToolParameterSchema[] | undefined;
  additionalProperties?: boolean | ToolParameterSchema | undefined;
}

/**
 * One argument that could not be repaired: where it is, and what it must be, in plain words.
 * `example` is a value of the right form, shown to the model; `optional` means it may be left out.
 */
export interface ArgumentProblem {
  path: string;
  expected: string;
  example: string | undefined;
  optional: boolean;
}

/**
 * Reads one call's argument text as a record; undefined when the text is not a finished JSON
 * object. A provider that streams no argument text sends the call with empty text for its
 * arguments, which the executor reads as an empty object; it is read the same way here, so the
 * schema check, not an "incomplete" refusal, decides what happens to such a call.
 */
export function parseToolCallArguments(call: RawToolCall): Record<string, unknown> | undefined {
  const text = call.function.arguments === '' ? '{}' : call.function.arguments;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readSchema(value: unknown): ToolParameterSchema | undefined {
  if (value === true) {
    // A schema of true allows any value: it reads as an empty schema, which checks nothing.
    return {};
  }
  if (value === false) {
    // A schema of false allows no value: an empty list of choices matches nothing, so any
    // value sent for it is a problem.
    return { enum: [] };
  }
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
  // A single allowed value (a literal such as type "search") reads as a list of one choice.
  const enumValues = Array.isArray(value['enum'])
    ? value['enum']
    : Object.hasOwn(value, 'const')
      ? [value['const']]
      : undefined;
  const anyOf = Array.isArray(value['anyOf'])
    ? value['anyOf']
        .map(entry => readSchema(entry))
        .filter((entry): entry is ToolParameterSchema => entry !== undefined)
    : undefined;
  const oneOf = Array.isArray(value['oneOf'])
    ? value['oneOf']
        .map(entry => readSchema(entry))
        .filter((entry): entry is ToolParameterSchema => entry !== undefined)
    : undefined;
  const allOf = Array.isArray(value['allOf'])
    ? value['allOf']
        .map(entry => readSchema(entry))
        .filter((entry): entry is ToolParameterSchema => entry !== undefined)
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
    ...(allOf !== undefined && allOf.length > 0 ? { allOf } : {}),
    ...(additionalProperties !== undefined ? { additionalProperties } : {}),
  };
}

/** Reads one offered tool's parameters (an unknown-shaped record) as a parameter schema. */
export function toParameterSchema(parameters: Record<string, unknown> | undefined): ToolParameterSchema {
  return readSchema(parameters) ?? {};
}

/** Most optional field names listed for an object option; the rest read as "and more". */
const MAX_OPTIONAL_FIELDS_LISTED = 6;

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) {
    return items.join('');
  }
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

function hasNamedFields(schema: ToolParameterSchema): boolean {
  return Object.keys(flattenAllOf(schema).properties ?? {}).length > 0;
}

/** One field of an object option: a literal reads as "type set to "search"", anything else as "search (text)". */
function describeField(input: { name: string; schema: ToolParameterSchema }): string {
  const { name, schema } = input;
  if (schema.enum?.length === 1) {
    return `${name} set to ${JSON.stringify(schema.enum[0])}`;
  }
  return `${name} (${describeSchema({ schema, detailed: false })})`;
}

/** An object that names its fields, in words: the fields it needs, then the ones it may also take. */
function describeObjectFields(schema: ToolParameterSchema): string {
  const flat = flattenAllOf(schema);
  const properties = flat.properties ?? {};
  const names = Object.keys(properties);
  const required = names.filter(name => flat.required?.includes(name) === true);
  const optional = names.filter(name => !required.includes(name));
  const needs = required.map(name => describeField({ name, schema: properties[name] ?? {} }));
  const shown = optional.slice(0, MAX_OPTIONAL_FIELDS_LISTED).join(', ');
  const more = optional.length > MAX_OPTIONAL_FIELDS_LISTED ? ' and more' : '';
  if (needs.length === 0) {
    return `an object with the optional fields ${shown}${more}`;
  }
  const optionally = optional.length === 0 ? '' : `, and optionally ${shown}${more}`;
  return `an object with ${joinWithAnd(needs)}${optionally}`;
}

/**
 * What a value must be, in plain words. An object that names its fields lists them, so a union of
 * object shapes tells each option apart. Only the top level lists fields (`detailed`): inside a
 * field, an object reads shortly, so a deep schema never becomes a wall of text.
 */
function describeSchema(input: { schema: ToolParameterSchema; detailed: boolean }): string {
  const { schema, detailed } = input;
  const union = schema.anyOf ?? schema.oneOf;
  if (union !== undefined && union.length > 0) {
    const options = [...new Set(union.map(member => describeSchema({ schema: member, detailed })))];
    if (options.length === 1) {
      return options.join('');
    }
    // Options that list fields can hold "and" and commas of their own, so they get a clear "either".
    return detailed && union.some(hasNamedFields)
      ? `either ${options.slice(0, -1).join(', ')}, or ${options.at(-1) ?? ''}`
      : options.join(' or ');
  }
  if (schema.enum?.length === 0) {
    return 'left out (this tool does not take a value here)';
  }
  if (schema.enum !== undefined && schema.enum.length > 0) {
    const shown = schema.enum.slice(0, 5).map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry)));
    return `one of: ${shown.join(', ')}`;
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (detailed && types.length === 1 && types[0] === 'object' && hasNamedFields(schema)) {
    return describeObjectFields(schema);
  }
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

/** The list a text holds when it is exactly a JSON list; undefined for any other text. */
function parseJsonArray(text: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface CheckOutcome {
  value: unknown;
  problems: ArgumentProblem[];
}

interface CheckInput {
  schema: ToolParameterSchema;
  value: unknown;
  path: string;
  /** True only for a read-only tool: an optional true-or-false field that cannot be repaired is dropped. */
  dropUnusableBooleans: boolean;
}

function problemAt(input: { path: string; schema: ToolParameterSchema }): ArgumentProblem {
  return { path: input.path, expected: describeSchema({ schema: input.schema, detailed: true }), example: undefined, optional: false };
}

/** A schema that takes only true or false (or null): the one shape whose bad value can be safely left out. */
function isBooleanOnly(schema: ToolParameterSchema): boolean {
  if (schema.anyOf !== undefined || schema.oneOf !== undefined || schema.enum !== undefined) {
    return false;
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  return types.includes('boolean') && types.every(type => type === 'boolean' || type === 'null');
}

function joinPath(input: { base: string; key: string }): string {
  return input.base === '' ? input.key : `${input.base}.${input.key}`;
}

/**
 * A schema read together with its allOf parts: every part must hold, so for checking, the
 * parts read as one schema whose named fields and required fields are the union of all of
 * them (recursively). Without this, a field declared only under allOf is treated as an
 * argument the tool does not have and silently dropped.
 */
function flattenAllOf(schema: ToolParameterSchema): ToolParameterSchema {
  if (schema.allOf === undefined || schema.allOf.length === 0) {
    return schema;
  }
  let properties = schema.properties;
  let required = schema.required;
  for (const member of schema.allOf) {
    const flat = flattenAllOf(member);
    if (flat.properties !== undefined) {
      properties = { ...flat.properties, ...(properties ?? {}) };
    }
    if (flat.required !== undefined) {
      required = [...new Set([...(required ?? []), ...flat.required])];
    }
  }
  return {
    ...schema,
    allOf: undefined,
    ...(properties !== undefined ? { properties } : {}),
    ...(required !== undefined ? { required } : {}),
  };
}

/** The one union option whose literal fields (such as type "block") all equal the value's own, if exactly one does. */
function memberNamedByValue(input: { union: ToolParameterSchema[]; value: unknown }): ToolParameterSchema | undefined {
  const { union, value } = input;
  if (!isRecord(value)) {
    return undefined;
  }
  const named = union.filter(member => {
    const literals = Object.entries(flattenAllOf(member).properties ?? {}).filter(
      ([, field]) => field.enum?.length === 1,
    );
    return (
      literals.length > 0 &&
      literals.every(([key, field]) => JSON.stringify(value[key]) === JSON.stringify(field.enum?.[0]))
    );
  });
  return named.length === 1 ? named[0] : undefined;
}

/**
 * Checks one value against one schema node, repairing what is safe: boolean text becomes a real
 * boolean, and inside an object that names its fields, entries the schema does not name are
 * dropped and an explicit null for an optional field is dropped. A value that still does not fit
 * comes back unchanged with a problem naming the field and what it should be.
 */
function checkValue(input: CheckInput): CheckOutcome {
  const { schema, value, path, dropUnusableBooleans } = input;

  const union = schema.anyOf ?? schema.oneOf;
  if (union !== undefined && union.length > 0) {
    // An exact fit wins; only then is a repaired fit used, so a repair in one member is never
    // preferred over a value that already fits another member unchanged.
    let repaired: CheckOutcome | undefined;
    for (const member of union) {
      const outcome = checkValue({ schema: member, value, path, dropUnusableBooleans });
      if (outcome.problems.length > 0) {
        continue;
      }
      if (JSON.stringify(outcome.value) === JSON.stringify(value)) {
        return outcome;
      }
      repaired ??= outcome;
    }
    if (repaired !== undefined) {
      return repaired;
    }
    // A value that names its own option (type "block") is held to that option's fields, so the
    // problem says which of them is wrong, not that the whole value fits no option.
    const named = memberNamedByValue({ union, value });
    return named === undefined
      ? { value, problems: [problemAt({ path, schema })] }
      : checkValue({ schema: named, value, path, dropUnusableBooleans });
  }

  if (schema.enum !== undefined) {
    const hit = schema.enum.some(entry => JSON.stringify(entry) === JSON.stringify(value));
    return hit ? { value, problems: [] } : { value, problems: [problemAt({ path, schema })] };
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (types.length === 0) {
    // No shape declared: only nested structure can still be checked.
    if (isRecord(value) && schema.properties !== undefined) {
      return checkObject({ schema, value, path, dropUnusableBooleans });
    }
    return { value, problems: [] };
  }
  if (types.length > 1) {
    const asUnion: ToolParameterSchema = { anyOf: types.map(type => ({ type })) };
    return checkValue({ schema: asUnion, value, path, dropUnusableBooleans });
  }
  const type = types[0] ?? '';

  if (!valueMatchesType(type, value)) {
    if (type === 'boolean' && typeof value === 'string') {
      const text = value.trim().toLowerCase();
      if (text === 'true' || text === 'false') {
        return { value: text === 'true', problems: [] };
      }
    }
    if (type === 'array' && typeof value === 'string') {
      // A list sent as its JSON text is the list itself, written one level too deep.
      const list = parseJsonArray(value);
      if (list !== undefined) {
        return checkValue({ schema, value: list, path, dropUnusableBooleans });
      }
    }
    return {
      value,
      problems: [{ ...problemAt({ path, schema }), example: type === 'boolean' ? 'true' : undefined }],
    };
  }
  if (type === 'object' && isRecord(value)) {
    return checkObject({ schema, value, path, dropUnusableBooleans });
  }
  if (type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    const problems: ArgumentProblem[] = [];
    const items = value.map((entry, index) => {
      const outcome = checkValue({
        schema: schema.items ?? {},
        value: entry,
        path: `${path}[${String(index)}]`,
        dropUnusableBooleans,
      });
      problems.push(...outcome.problems);
      return outcome.value;
    });
    return { value: items, problems };
  }
  return { value, problems: [] };
}

function checkObject(input: CheckInput & { value: Record<string, unknown> }): CheckOutcome {
  const { value, path, dropUnusableBooleans } = input;
  const schema = flattenAllOf(input.schema);
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
        const outcome = checkValue({
          schema: schema.additionalProperties,
          value: entry,
          path: joinPath({ base: path, key }),
          dropUnusableBooleans,
        });
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
    const keyPath = joinPath({ base: path, key });
    const outcome = checkValue({ schema: propertySchema, value: entry, path: keyPath, dropUnusableBooleans });
    const optional = !required.has(key);
    if (outcome.problems.length > 0 && optional && dropUnusableBooleans && isBooleanOnly(propertySchema)) {
      // A read-only tool runs the same with the field left out, so an unusable value reads as "not given".
      continue;
    }
    problems.push(
      ...outcome.problems.map(problem => (problem.path === keyPath ? { ...problem, optional } : problem)),
    );
    cleaned[key] = outcome.value;
  }
  for (const name of required) {
    if (!(name in cleaned) && !(name in value)) {
      problems.push({
        path: joinPath({ base: path, key: name }),
        expected: `${describeSchema({ schema: properties[name] ?? {}, detailed: true })} (this one is required)`,
        example: undefined,
        optional: false,
      });
    }
  }
  return { value: cleaned, problems };
}

/**
 * Checks a whole call's arguments. Returns the arguments to send (repaired and pruned) and the
 * problems that could not be repaired. A call with problems must not be sent; the problems are
 * the model's instructions for its one retry. `readOnly` must be true only for a read the host itself
 * vouches for, never on a server's own claim: then an optional true-or-false argument that cannot be
 * repaired is dropped.
 */
export function checkToolArguments(input: {
  schema: ToolParameterSchema;
  args: Record<string, unknown>;
  readOnly: boolean;
}): {
  args: Record<string, unknown>;
  problems: ArgumentProblem[];
} {
  const outcome = checkObject({
    schema: input.schema,
    value: input.args,
    path: '',
    dropUnusableBooleans: input.readOnly,
  });
  return { args: isRecord(outcome.value) ? outcome.value : input.args, problems: outcome.problems };
}

/**
 * Drops the top-level arguments a tool's schema does not name, by the same rule the full check uses:
 * only a schema that names its properties and allows no extras drops anything, so a tool without a
 * schema, or one that takes free-form input, keeps every argument. Nothing else is changed.
 */
export function dropUnnamedArguments(input: { schema: ToolParameterSchema; args: Record<string, unknown> }): {
  args: Record<string, unknown>;
  dropped: string[];
} {
  const schema = flattenAllOf(input.schema);
  const properties = schema.properties ?? {};
  if (
    Object.keys(properties).length === 0 ||
    schema.additionalProperties === true ||
    isRecord(schema.additionalProperties)
  ) {
    return { args: input.args, dropped: [] };
  }
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(input.args)) {
    if (Object.hasOwn(properties, key)) {
      kept[key] = value;
    } else {
      dropped.push(key);
    }
  }
  return { args: dropped.length === 0 ? input.args : kept, dropped };
}

function describeProblem(problem: ArgumentProblem): string {
  // A list item's path ends in [n], so it has no field name to show in the example.
  const field = problem.path.split('.').at(-1) ?? problem.path;
  const example =
    problem.example === undefined
      ? ''
      : field.endsWith(']')
        ? `, for example ${problem.example}`
        : `, for example "${field}": ${problem.example}`;
  return `${problem.path} must be ${problem.expected}${example}${problem.optional ? ', or leave it out' : ''}`;
}

/** The plain message the model gets when its call was not sent: what is wrong and what it must be. */
export function toolArgumentProblemMessage(input: { toolName: string; problems: ArgumentProblem[] }): string {
  const parts = input.problems.map(describeProblem);
  return (
    `The ${input.toolName} call was not sent because some of its arguments were wrong, so nothing was done with it. ` +
    `Fix these and try once more: ${parts.join('; ')}.`
  );
}
