/**
 * Lenient reading for what Aman keeps about a chat for itself (tool enrichment, turn events,
 * metrics, runtime state). Those shapes change between versions, so an archive from a version
 * whose internals differ must still import: a value that no longer fits is repaired field by
 * field or left out, and counted, never a reason to refuse the archive. The people's own data
 * stays strict (see importSchemas.ts).
 */
import { z } from 'zod';

let tally: { leftOut: number } | undefined;

/** Runs a synchronous parse and reports how many internal details it repaired or left out. */
export function countingLeftOut<T>(run: () => T): { result: T; leftOut: number } {
  const outer = tally;
  const current = { leftOut: 0 };
  tally = current;
  try {
    return { result: run(), leftOut: current.leftOut };
  } finally {
    tally = outer;
  }
}

/** Counts one internal detail left out by a reader of its own. */
export function noteLeftOut(): void {
  if (tally !== undefined) {
    tally.leftOut += 1;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Values that say nothing, tried in order; a literal never matches one, so a discriminator is never invented. */
const NEUTRAL_CANDIDATES: readonly unknown[] = [undefined, null, '', 0, false, [], {}];

/** A parsed value for `schema` built from `value`, keeping every field that still fits. */
function repaired(schema: z.ZodType, value: unknown): { value: unknown } | undefined {
  const direct = schema.safeParse(value);
  if (direct.success) {
    return { value: direct.data };
  }
  if (schema instanceof z.ZodObject && isRecord(value)) {
    const fields: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema.shape)) {
      if (!(field instanceof z.ZodType)) {
        continue;
      }
      const fixed = repaired(field, value[key]) ?? neutral(field);
      if (fixed?.value !== undefined) {
        fields[key] = fixed.value;
      }
    }
    const again = schema.safeParse(fields);
    return again.success ? { value: again.data } : undefined;
  }
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) {
      if (option instanceof z.ZodType) {
        const fixed = repaired(option, value);
        if (fixed !== undefined) {
          return fixed;
        }
      }
    }
  }
  return undefined;
}

function neutral(schema: z.ZodType): { value: unknown } | undefined {
  for (const candidate of NEUTRAL_CANDIDATES) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) {
      return { value: parsed.data };
    }
  }
  if (schema instanceof z.ZodEnum) {
    const [first] = schema.options;
    return first === undefined ? undefined : { value: first };
  }
  return schema instanceof z.ZodObject ? repaired(schema, {}) : undefined;
}

/**
 * `value` read against an internal schema: as is when it fits, else repaired, else `fallback`,
 * else undefined when nothing fits. Anything but an exact fit is counted as left out.
 */
export function readInternal<T extends z.ZodType>(
  schema: T,
  value: unknown,
  fallback?: z.input<T>,
): z.output<T> | undefined {
  const direct = schema.safeParse(value);
  if (direct.success) {
    return direct.data;
  }
  noteLeftOut();
  const fixed = repaired(schema, value) ?? (fallback === undefined ? neutral(schema) : { value: fallback });
  const parsed = schema.safeParse(fixed?.value);
  return parsed.success ? parsed.data : undefined;
}

/** Stands in for a key the archive leaves out, so the field is still read (and repaired) instead of skipped. */
const MISSING = Symbol('missing');

/** A field of internal detail: never fails; see readInternal. */
export function internal<T extends z.ZodType>(schema: T, fallback?: z.input<T>) {
  return z
    .unknown()
    .transform((value, ctx) => {
      const parsed = schema.safeParse(readInternal(schema, value === MISSING ? undefined : value, fallback));
      if (!parsed.success) {
        ctx.addIssue({ code: 'custom', message: 'An internal detail could not be read or replaced.' });
        return z.NEVER;
      }
      return parsed.data;
    })
    .prefault(MISSING);
}

/** A list of internal records, such as turn events: each one is repaired or left out. */
export function internalList<T extends z.ZodType>(schema: T) {
  return z.array(z.unknown()).transform(items =>
    items.flatMap(item => {
      const read = readInternal(schema, item);
      return read === undefined ? [] : [read];
    }),
  );
}
