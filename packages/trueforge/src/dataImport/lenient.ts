/**
 * Lenient reading for what Aman keeps about a chat for itself (tool enrichment, telemetry
 * events, metrics, runtime state). Those shapes change between versions, so an archive from a
 * version whose internals differ must still import: a value that no longer fits is repaired
 * field by field or left out, and counted. What people see stays strict (see importSchemas.ts).
 */
import { z } from 'zod';

/** Internal details repaired or left out, by the plain label of what they were. */
export type LeftOutCounts = ReadonlyMap<string, number>;

let tally: Map<string, number> | undefined;

/**
 * Runs a synchronous parse and reports what it repaired or left out. Every reader below notes
 * each change here, so nothing is left out without the person being told.
 */
export function countingLeftOut<T>(run: () => T): { result: T; leftOut: LeftOutCounts } {
  const outer = tally;
  const current = new Map<string, number>();
  tally = current;
  try {
    return { result: run(), leftOut: current };
  } finally {
    tally = outer;
  }
}

/** Notes internal details left out by a reader, under the label the person is shown. */
export function noteLeftOut({ label, count = 1 }: { label: string; count?: number }): void {
  if (tally !== undefined && count > 0) {
    tally.set(label, (tally.get(label) ?? 0) + count);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Values that say nothing, tried in order. A literal or an enum never matches one, so a
 * discriminator or a recorded decision is never invented: a record that needs one is left out.
 */
const NEUTRAL_CANDIDATES: readonly unknown[] = [undefined, null, '', 0, false, [], {}];

/** Keys that hold Aman's own enrichment wherever they appear, even inside what people see. */
const INTERNAL_KEYS: ReadonlySet<string> = new Set(['tool_info', 'tier3_card', 'maps_hosts']);

/** `all`: any part may be repaired. `internal-keys`: only values under INTERNAL_KEYS may be. */
type RepairScope = 'all' | 'internal-keys';

interface Repair {
  value: unknown;
  /** Internal details replaced or left out on the way. */
  changes: number;
}

function neutral(schema: z.ZodType): Repair | undefined {
  for (const candidate of NEUTRAL_CANDIDATES) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) {
      return { value: parsed.data, changes: 1 };
    }
  }
  return schema instanceof z.ZodObject ? repaired(schema, { value: {}, scope: 'all' }) : undefined;
}

/** A parsed value for `schema` built from `value`, keeping every part that still fits. */
function repaired(schema: z.ZodType, { value, scope }: { value: unknown; scope: RepairScope }): Repair | undefined {
  const direct = schema.safeParse(value);
  if (direct.success) {
    return { value: direct.data, changes: 0 };
  }
  if ((schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) && value !== undefined && value !== null) {
    const inner = schema.unwrap();
    return inner instanceof z.ZodType ? repaired(inner, { value, scope }) : undefined;
  }
  if (schema instanceof z.ZodObject && isRecord(value)) {
    const fields: Record<string, unknown> = {};
    let changes = 0;
    for (const [key, field] of Object.entries(schema.shape)) {
      if (!(field instanceof z.ZodType)) {
        continue;
      }
      const fieldScope = scope === 'all' || INTERNAL_KEYS.has(key) ? 'all' : 'internal-keys';
      const fixed =
        repaired(field, { value: value[key], scope: fieldScope }) ??
        (fieldScope === 'all' ? neutral(field) : undefined);
      // A field nothing can stand in for means the record cannot be rebuilt.
      if (fixed === undefined) {
        return undefined;
      }
      changes += fixed.changes;
      if (fixed.value !== undefined) {
        fields[key] = fixed.value;
      }
    }
    const again = schema.safeParse(fields);
    return again.success ? { value: again.data, changes: Math.max(changes, 1) } : undefined;
  }
  if (schema instanceof z.ZodArray && Array.isArray(value)) {
    const element = schema.element;
    if (!(element instanceof z.ZodType)) {
      return undefined;
    }
    const items: unknown[] = [];
    let changes = 0;
    for (const item of value) {
      const fixed = repaired(element, { value: item, scope });
      if (fixed === undefined) {
        if (scope !== 'all') {
          return undefined;
        }
        // One record that no longer fits leaves the list without it.
        changes += 1;
        continue;
      }
      changes += fixed.changes;
      items.push(fixed.value);
    }
    const again = schema.safeParse(items);
    return again.success ? { value: again.data, changes: Math.max(changes, 1) } : undefined;
  }
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) {
      if (option instanceof z.ZodType) {
        const fixed = repaired(option, { value, scope });
        if (fixed !== undefined) {
          return fixed;
        }
      }
    }
  }
  return undefined;
}

function counted(repair: Repair, label: string): unknown {
  noteLeftOut({ label, count: repair.changes });
  return repair.value;
}

interface ReadOptions<T extends z.ZodType> {
  /** What the person is told was left out, such as "tool detail". */
  label: string;
  fallback?: z.input<T>;
}

/**
 * `value` read against an internal schema: as is when it fits, else repaired, else `fallback`,
 * else undefined when nothing fits. Every repair is counted as left out.
 */
export function readInternal<T extends z.ZodType>(
  schema: T,
  value: unknown,
  { label, fallback }: ReadOptions<T>,
): z.output<T> | undefined {
  const direct = schema.safeParse(value);
  if (direct.success) {
    return direct.data;
  }
  const fixed =
    repaired(schema, { value, scope: 'all' }) ??
    (fallback === undefined ? neutral(schema) : { value: fallback, changes: 1 });
  if (fixed === undefined) {
    noteLeftOut({ label });
    return undefined;
  }
  const parsed = schema.safeParse(counted(fixed, label));
  return parsed.success ? parsed.data : undefined;
}

/**
 * `value` read against a schema for what people see: it must fit as is, except for internal
 * enrichment under INTERNAL_KEYS, which is repaired. Otherwise the strict result says where it fails.
 */
export function readVisible<T extends z.ZodType>(
  schema: T,
  value: unknown,
  { label }: { label: string },
): z.ZodSafeParseResult<z.output<T>> {
  const direct = schema.safeParse(value);
  if (direct.success) {
    return direct;
  }
  const fixed = repaired(schema, { value, scope: 'internal-keys' });
  if (fixed === undefined) {
    return direct;
  }
  const parsed = schema.safeParse(counted(fixed, label));
  return parsed.success ? parsed : direct;
}

/** Stands in for a key the archive leaves out, so the field is still read (and repaired) instead of skipped. */
const MISSING = Symbol('missing');

/** A field of internal detail; it fails only when nothing at all can stand in for it. */
export function internal<T extends z.ZodType>(schema: T, options: ReadOptions<T>) {
  return z
    .unknown()
    .transform((value, ctx) => {
      const parsed = schema.safeParse(readInternal(schema, value === MISSING ? undefined : value, options));
      if (!parsed.success) {
        ctx.addIssue({ code: 'custom', message: 'An internal detail could not be read or replaced.' });
        return z.NEVER;
      }
      return parsed.data;
    })
    .prefault(MISSING);
}

/** Reports a strict failure inside a transform at the place it happened. */
export function forwardIssues(
  ctx: z.RefinementCtx,
  { issues, path }: { issues: readonly z.core.$ZodIssue[]; path: readonly PropertyKey[] },
): void {
  for (const issue of issues) {
    ctx.addIssue({ ...issue, path: [...path, ...issue.path] });
  }
}

/** A field of what people see; see readVisible. */
export function visible<T extends z.ZodType>(schema: T, options: { label: string }) {
  return z.unknown().transform((value, ctx) => {
    const parsed = readVisible(schema, value, options);
    if (!parsed.success) {
      forwardIssues(ctx, { issues: parsed.error.issues, path: [] });
      return z.NEVER;
    }
    return parsed.data;
  });
}

/**
 * A list of records where `isVisible` picks the ones people see, which are read strictly (see
 * readVisible); every other record is repaired or left out.
 */
export function mixedList<T extends z.ZodType>({
  schema,
  isVisible,
  label,
  visibleLabel,
}: {
  schema: T;
  isVisible: (item: unknown) => boolean;
  /** What an internal record left out is called. */
  label: string;
  /** What repaired enrichment inside a visible record is called. */
  visibleLabel: string;
}) {
  return z.array(z.unknown()).transform((items, ctx) => {
    const kept: z.output<T>[] = [];
    for (const [index, item] of items.entries()) {
      if (isVisible(item)) {
        const parsed = readVisible(schema, item, { label: visibleLabel });
        if (!parsed.success) {
          forwardIssues(ctx, { issues: parsed.error.issues, path: [index] });
          return z.NEVER;
        }
        kept.push(parsed.data);
        continue;
      }
      const read = readInternal(schema, item, { label });
      if (read !== undefined) {
        kept.push(read);
      }
    }
    return kept;
  });
}
