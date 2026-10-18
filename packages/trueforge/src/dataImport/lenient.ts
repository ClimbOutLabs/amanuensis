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

/** Telemetry inside what people see. Each is optional, so a value that no longer fits is dropped, never filled in. */
const TELEMETRY_KEYS: ReadonlySet<string> = new Set(['usage', 'metrics', 'handoff']);

interface RepairMode {
  /** `all`: any part may be repaired. `internal-keys`: only values under INTERNAL_KEYS and TELEMETRY_KEYS may be. */
  scope: 'all' | 'internal-keys';
  /** Whether a required field that no longer fits may take a neutral value; otherwise its record is left out. */
  fill: boolean;
}

interface Repair {
  value: unknown;
  /** Something in the value was replaced or dropped. */
  fixed: boolean;
  /** List items left out, each its own detail. */
  droppedItems: number;
}

/** One for a garbled value, plus one for each list item it lost. */
function repairCount(repair: Repair): number {
  return repair.droppedItems + (repair.fixed ? 1 : 0);
}

function neutral(schema: z.ZodType): Repair | undefined {
  for (const candidate of NEUTRAL_CANDIDATES) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) {
      return { value: parsed.data, fixed: true, droppedItems: 0 };
    }
  }
  if (!(schema instanceof z.ZodObject)) {
    return undefined;
  }
  const built = repaired(schema, { value: {}, mode: { scope: 'all', fill: true } });
  return built === undefined ? undefined : { ...built, fixed: true };
}

function acceptsUndefined(schema: z.ZodType): boolean {
  return schema.safeParse(undefined).success;
}

/** A parsed value for `schema` built from `value`, keeping every part that still fits. */
function repaired(schema: z.ZodType, { value, mode }: { value: unknown; mode: RepairMode }): Repair | undefined {
  const direct = schema.safeParse(value);
  if (direct.success) {
    return { value: direct.data, fixed: false, droppedItems: 0 };
  }
  if ((schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) && value !== undefined && value !== null) {
    const inner = schema.unwrap();
    return inner instanceof z.ZodType ? repaired(inner, { value, mode }) : undefined;
  }
  if (schema instanceof z.ZodObject && isRecord(value)) {
    const fields: Record<string, unknown> = {};
    let anyFixed = false;
    let droppedItems = 0;
    for (const [key, field] of Object.entries(schema.shape)) {
      if (!(field instanceof z.ZodType)) {
        continue;
      }
      const fieldMode: RepairMode =
        mode.scope === 'all'
          ? mode
          : INTERNAL_KEYS.has(key)
            ? { scope: 'all', fill: true }
            : TELEMETRY_KEYS.has(key)
              ? { scope: 'all', fill: false }
              : mode;
      let fixed = repaired(field, { value: value[key], mode: fieldMode });
      if (fixed === undefined && fieldMode.scope === 'all') {
        fixed = acceptsUndefined(field)
          ? { value: undefined, fixed: true, droppedItems: 0 }
          : fieldMode.fill
            ? neutral(field)
            : undefined;
      }
      // A field nothing can stand in for means the record cannot be rebuilt.
      if (fixed === undefined) {
        return undefined;
      }
      anyFixed ||= fixed.fixed;
      droppedItems += fixed.droppedItems;
      if (fixed.value !== undefined) {
        fields[key] = fixed.value;
      }
    }
    const again = schema.safeParse(fields);
    // A record that failed only on keys this version does not know still counts as repaired.
    return again.success ? { value: again.data, fixed: anyFixed || droppedItems === 0, droppedItems } : undefined;
  }
  if (schema instanceof z.ZodArray && Array.isArray(value)) {
    const element = schema.element;
    if (!(element instanceof z.ZodType)) {
      return undefined;
    }
    const items: unknown[] = [];
    let anyFixed = false;
    let droppedItems = 0;
    for (const item of value) {
      const fixed = repaired(element, { value: item, mode });
      if (fixed === undefined) {
        if (mode.scope !== 'all') {
          return undefined;
        }
        // One record that no longer fits leaves the list without it.
        droppedItems += 1;
        continue;
      }
      anyFixed ||= fixed.fixed;
      droppedItems += fixed.droppedItems;
      items.push(fixed.value);
    }
    const again = schema.safeParse(items);
    return again.success ? { value: again.data, fixed: anyFixed || droppedItems === 0, droppedItems } : undefined;
  }
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) {
      if (option instanceof z.ZodType) {
        const fixed = repaired(option, { value, mode });
        if (fixed !== undefined) {
          return fixed;
        }
      }
    }
  }
  return undefined;
}

function counted(repair: Repair, label: string): unknown {
  noteLeftOut({ label, count: repairCount(repair) });
  return repair.value;
}

interface ReadOptions<T extends z.ZodType> {
  /** What the person is told was left out, such as "tool detail". */
  label: string;
  fallback?: z.input<T>;
  /** False leaves a record out rather than give a required field a neutral value; default true. */
  fill?: boolean;
}

/**
 * `value` read against an internal schema: as is when it fits, else repaired, else `fallback`,
 * else undefined when nothing fits. Every repair is counted as left out.
 */
export function readInternal<T extends z.ZodType>(
  schema: T,
  value: unknown,
  { label, fallback, fill = true }: ReadOptions<T>,
): z.output<T> | undefined {
  const direct = schema.safeParse(value);
  if (direct.success) {
    return direct.data;
  }
  const fixed =
    repaired(schema, { value, mode: { scope: 'all', fill } }) ??
    (fallback !== undefined ? { value: fallback, fixed: true, droppedItems: 0 } : fill ? neutral(schema) : undefined);
  if (fixed === undefined) {
    noteLeftOut({ label });
    return undefined;
  }
  const parsed = schema.safeParse(counted(fixed, label));
  return parsed.success ? parsed.data : undefined;
}

/**
 * `value` read against a schema for what people see: it must fit as is, except for internal
 * enrichment and telemetry under INTERNAL_KEYS and TELEMETRY_KEYS, which is repaired or dropped.
 * Otherwise the strict result says where it fails.
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
  const fixed = repaired(schema, { value, mode: { scope: 'internal-keys', fill: true } });
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
      // A record people may still see is never given made-up values: it is read as it is, or left out.
      const read = readInternal(schema, item, { label, fill: false });
      if (read !== undefined) {
        kept.push(read);
      }
    }
    return kept;
  });
}
