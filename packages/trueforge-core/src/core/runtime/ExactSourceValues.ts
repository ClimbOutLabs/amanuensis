import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ToolCallResult } from '../mcp/executeToolCalls';
import { toolResultResponse } from '../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../mcp/LocalToolMCP';
import type { AgentTracing } from '../tracing/AgentTracing';
import { isRecord } from '../util/records';

const TOOL_NAME = 'present_exact_values';
/** The tool result text a successful presentation leaves in the persisted context. */
const PRESENTATION_ACCEPTED_TEXT =
  'Those values will be shown in the reply. Call this tool again by itself to show more values, or finish with an empty message.';
const MAX_ROWS = 50;
const MAX_FIELDS = 24;
// One presentation call renders one section of the reply. A result with more fields is
// shown across successive calls, and the host joins the sections in the order presented.
const MAX_FIELDS_IN_ANSWER = 40;
const MAX_SOURCE_CHARS = 32_000;
const MAX_FIELD_CHARS = 160;
const MAX_RECORD_DEPTH = 4;
const MAX_VISITED_NODES = 1_000;
const DECIMAL = /^-?[0-9]+(?:\.[0-9]+)?$/;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const FieldPath = z.string().min(1).max(MAX_FIELD_CHARS);
const RowReference = z.string().regex(/^row_[A-Za-z0-9_-]{12}$/);
const PresentExactValuesSchema = z.strictObject({
  rows: z
    .array(z.strictObject({ ref: RowReference, fields: z.array(FieldPath).min(1).max(MAX_FIELDS) }))
    .min(1)
    .max(MAX_ROWS)
    .describe('Rows and field paths from the exact_source_rows list on this turn’s connector results.'),
  sum: z
    .strictObject({
      refs: z.array(RowReference).min(1).max(MAX_ROWS),
      value_field: FieldPath,
      unit_field: FieldPath,
    })
    .nullable()
    .default(null)
    .describe('Optional sum of one numeric field across rows from one result with a matching unit or currency field.'),
});
type PresentExactValuesInput = z.infer<typeof PresentExactValuesSchema>;

type ExactValue = string | number | boolean;
interface ExactRow {
  ref: string;
  source: { connector: string; tool: string; call_id: string; path: string };
  fields: ReadonlyMap<string, ExactValue>;
}

/** A connector result as persisted in the current request's context, with the names of the call that produced it. */
export interface ExactContextResult {
  call_id: string;
  connector: string;
  tool: string;
  content: string;
}

/** A presentation call as persisted in the current request's context. */
export interface ExactContextPresentation {
  arguments: string;
  succeeded: boolean;
}

const EXACT_SOURCE_INSTRUCTIONS =
  'For a reply reporting exact values from these rows, call present_exact_values by itself. Select row references and field paths. Call it again by itself to show more values. Finish with an empty message when every value is shown; the host writes the reply from the values shown.';

const ExactFieldValue = z.union([z.string(), z.number(), z.boolean()]);

const ReplacedContentSchema = z.object({
  connector_result: z.unknown(),
  exact_source_rows: z.array(
    z.object({
      ref: RowReference,
      path: FieldPath,
      fields: z.array(FieldPath),
      // The exact value of each advertised field, as prepare() derived it from the
      // admitted result text. A stored envelope in the earlier shape, whose rows name
      // fields but carry no values, does not match this schema and is not adopted:
      // its values could only be re-derived from a plainer copy of the result.
      values: z.record(FieldPath, ExactFieldValue),
    }),
  ),
  exact_source_instructions: z.literal(EXACT_SOURCE_INSTRUCTIONS),
});
type ReplacedContent = z.infer<typeof ReplacedContentSchema>;

/**
 * Read the replaced result content out of a persisted tool message, when it carries one.
 * The message content is the tool response envelope; its result is the content the model
 * was shown, which prepare() replaced with the connector result and its exact source rows.
 */
function replacedContentOf(content: string): ReplacedContent | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(envelope)) {
    return undefined;
  }
  let result: unknown = envelope['result'];
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      return undefined;
    }
  }
  const parsed = ReplacedContentSchema.safeParse(result);
  return parsed.success ? parsed.data : undefined;
}

/** Whether a persisted presentation call was accepted, read from its tool message content. */
export function exactPresentationSucceeded(content: string): boolean {
  let envelope: unknown;
  try {
    envelope = JSON.parse(content);
  } catch {
    return false;
  }
  return isRecord(envelope) && envelope['result'] === PRESENTATION_ACCEPTED_TEXT;
}

function childPath({ path, key }: { path: string; key: string }): string {
  return `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function safeText(value: string): boolean {
  return value.length > 0 && value.length <= MAX_FIELD_CHARS && !CONTROL.test(value);
}

function scalar(value: unknown): ExactValue | undefined {
  if (typeof value === 'string') {
    return safeText(value) ? value : undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  // Numbers already parsed by the connector may have lost digits. Whole numbers are exact in this range.
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  return undefined;
}

/**
 * Parse a connector result so plain decimal number literals keep their exact source text.
 * The text is scanned once: outside string literals, a number written as a plain decimal
 * (digits with an optional fraction, no exponent) is quoted, so the parse yields it as a
 * string carrying the literal digit for digit. A fractional amount therefore stays exact
 * instead of passing through a binary float, and an integer too large for a float keeps
 * every digit. A number written with an exponent is left as a number and parsed the usual
 * way, so it is accepted as a field only when it lands on a whole number in the safe range,
 * exactly as before. The caller has already parsed the same text plainly, so the input is
 * known to be valid JSON and a number sign or digit outside a string always opens a number.
 */
function parseWithExactDecimals(text: string): unknown {
  let rewritten = '';
  let inString = false;
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (inString) {
      rewritten += char;
      if (char === '\\') {
        rewritten += text.charAt(index + 1);
        index += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      rewritten += char;
      index += 1;
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      let end = index + 1;
      while (end < text.length && '0123456789.eE+-'.includes(text.charAt(end))) {
        end += 1;
      }
      const literal = text.slice(index, end);
      rewritten += DECIMAL.test(literal) ? `"${literal}"` : literal;
      index = end;
      continue;
    }
    rewritten += char;
    index += 1;
  }
  return JSON.parse(rewritten);
}

/**
 * The value at a JSON Pointer path inside a plainly parsed result, or undefined when
 * the path does not resolve. Segments are the pointer's own: '~1' stands for a slash
 * and '~0' for a tilde inside a key, and an array member is named by its index.
 */
function valueAtPath(root: unknown, path: string): unknown {
  if (path === '') {
    return root;
  }
  let current: unknown = root;
  for (const segment of path.slice(1).split('/')) {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(key)) {
        return undefined;
      }
      current = current[Number(key)];
    } else if (isRecord(current)) {
      current = current[key];
    } else {
      return undefined;
    }
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

/**
 * Whether the plainly parsed result agrees that a field stands at its path with a
 * value of the kind the row record carries. The plain parse preserves strings and
 * booleans exactly, so those must match. Its numbers are already rounded, so a number
 * in the plain copy is only asked to confirm that the source wrote a number at this
 * path: the digits presented are always the row record's own, never the plain copy's.
 */
function plainCopyAgrees(plain: unknown, value: ExactValue): boolean {
  if (typeof value === 'string') {
    if (typeof plain === 'string') {
      return plain === value;
    }
    return typeof plain === 'number' && DECIMAL.test(value);
  }
  if (typeof value === 'number') {
    return typeof plain === 'number';
  }
  return plain === value;
}

/** Collect leaf fields within one row. Arrays are different rows, never siblings to merge. */
function fieldsOf(record: Record<string, unknown>): Map<string, ExactValue> {
  const fields = new Map<string, ExactValue>();
  function visit(value: unknown, path: string, depth: number): void {
    if (fields.size >= MAX_FIELDS || depth > MAX_RECORD_DEPTH || path.length > MAX_FIELD_CHARS) {
      return;
    }
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (safeText(key)) {
          visit(child, childPath({ path, key }), depth + 1);
        }
      }
      return;
    }
    const valueToShow = scalar(value);
    if (valueToShow !== undefined) {
      fields.set(path, valueToShow);
    }
  }
  visit(record, '', 0);
  return fields;
}

function rowsOf(value: unknown): { path: string; fields: Map<string, ExactValue> }[] {
  const rows: { path: string; fields: Map<string, ExactValue> }[] = [];
  let visitedNodes = 0;
  function add(fields: Map<string, ExactValue>, path: string): void {
    if (
      [...fields.values()].some(
        value => typeof value === 'number' || (typeof value === 'string' && /[0-9]/.test(value)),
      )
    ) {
      rows.push({ path, fields });
    }
  }
  function visit(value: unknown, path: string, depth: number): void {
    if (
      rows.length >= MAX_ROWS ||
      visitedNodes++ >= MAX_VISITED_NODES ||
      depth > MAX_RECORD_DEPTH ||
      path.length > MAX_FIELD_CHARS
    ) {
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, member] of value.entries()) {
        if (rows.length >= MAX_ROWS || visitedNodes >= MAX_VISITED_NODES) {
          break;
        }
        const rowPath = childPath({ path, key: String(index) });
        if (isRecord(member) && rowPath.length <= MAX_FIELD_CHARS) {
          add(fieldsOf(member), rowPath);
        }
        visit(member, rowPath, depth + 1);
      }
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (safeText(key)) {
          visit(child, childPath({ path, key }), depth + 1);
        }
      }
    }
  }
  visit(value, '', 0);
  // Direct structured records have no containing array.
  if (rows.length === 0 && isRecord(value)) {
    add(fieldsOf(value), '');
  }
  return rows;
}

function decimal(value: ExactValue | undefined): { coefficient: bigint; scale: number } | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const text = String(value);
  if (!DECIMAL.test(text)) {
    return undefined;
  }
  const scale = text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
  return { coefficient: BigInt(text.replace('.', '')), scale };
}

/** The outcome of checking one presentation call: the rendered section, or the refusal to report. */
type SectionOutcome = { text: string } | { refusal: string };

/**
 * Write one piece of source text into the Markdown reply so the rendered text matches the
 * source character for character. The reply is rendered as Markdown, where characters
 * such as asterisks, underscores, backticks and brackets change the visible text: an
 * identifier like LOT*12*A would show its digits in italics with the asterisks gone.
 * Text carrying no such character is returned unchanged, so ordinary values render as
 * before. Text that does carry one has each Markdown delimiter in it escaped with a
 * backslash, which the renderer shows as the literal character. A doubled dollar sign is
 * a delimiter too, because the renderer treats it as the start of a math span. The
 * ampersand is escaped in the same single pass as the rest: an entity the source wrote,
 * such as &amp;, must show as those very characters, and escaping the ampersand in an
 * earlier pass let the backslash that pass introduced be escaped again, which left a
 * stray backslash in front of the decoded character.
 */
const MARKDOWN_DELIMITER = /[\\*_`[\]<~]|\$\$/;
const HTML_ENTITY = /&(?=#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]+;)/;

function markdownText(text: string): string {
  if (!MARKDOWN_DELIMITER.test(text) && !HTML_ENTITY.test(text)) {
    return text;
  }
  return text.replace(/[\\&*_`[\]<~$]/g, character => `\\${character}`);
}

/**
 * Write a label where it will stand at the start of its line. Away from the start of a
 * line, the characters Markdown reads as block markers are ordinary text, but a leading
 * "# ", "- " or "+ " opens a heading or a list, a leading ">" opens a quotation, and a
 * leading "1. " or "2) " opens a numbered list, each swallowing the marker itself. Put a
 * backslash in front of the one character the parser keys on, so the line stays a plain
 * line and shows the label exactly as the source wrote it. The Source line and the sum
 * line need no such care: both begin with a fixed word, so the connector name and the
 * unit never stand at the start of a line.
 */
function markdownLabel(text: string): string {
  return markdownText(text)
    .replace(/(^|\n)( {0,3})(?=#+[ \t]|>|[-+][ \t])/g, '$1$2\\')
    .replace(/(^|\n)( {0,3}\d{1,9})(?=[.)][ \t])/g, '$1$2\\');
}

/** A field path as a plain label a person reads: the path segments in words, in order. */
function labelOf(path: string): string {
  const words = path
    .slice(1)
    .split('/')
    .map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~').replaceAll('_', ' '))
    .join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function checkedSum(
  sum: NonNullable<PresentExactValuesInput['sum']>,
  rows: ReadonlyMap<string, ExactRow>,
  selections: PresentExactValuesInput['rows'],
): { total: string; unit: string } | { refusal: string } {
  if (new Set(sum.refs).size !== sum.refs.length) {
    return { refusal: 'The sum names the same row more than once. Name each summed row once.' };
  }
  if (
    sum.value_field === sum.unit_field ||
    sum.value_field.slice(0, sum.value_field.lastIndexOf('/')) !==
      sum.unit_field.slice(0, sum.unit_field.lastIndexOf('/'))
  ) {
    return {
      refusal:
        'The sum needs an amount field and a unit field that sit side by side on each row. Choose two fields from the same level.',
    };
  }
  // Every operand stays visible with its provenance in the same section as the total.
  const selectionByRef = new Map(selections.map(selection => [selection.ref, selection.fields]));
  for (const ref of sum.refs) {
    const fields = selectionByRef.get(ref);
    if (fields === undefined || !fields.includes(sum.value_field) || !fields.includes(sum.unit_field)) {
      return {
        refusal: `Every summed row must also be shown with its ${sum.value_field} and ${sum.unit_field} fields. Add the missing fields to the shown rows.`,
      };
    }
  }
  let unit: string | undefined;
  let resultId: string | undefined;
  let coefficient = 0n;
  let scale = 0;
  for (const ref of sum.refs) {
    const row = rows.get(ref);
    if (row === undefined) {
      return {
        refusal: `The row reference ${ref} is not from this request. Use only the row references listed with this turn's results.`,
      };
    }
    if (resultId !== undefined && row.source.call_id !== resultId) {
      return { refusal: 'The sum mixes rows from more than one result. Sum rows from a single result.' };
    }
    const value = decimal(row.fields.get(sum.value_field));
    if (value === undefined) {
      return {
        refusal: `The field ${sum.value_field} on the row at ${row.source.path || '/'} is not a plain number, so it cannot be summed. Sum a field that holds plain numbers.`,
      };
    }
    const rowUnit = row.fields.get(sum.unit_field);
    if (typeof rowUnit !== 'string' || rowUnit.trim() === '') {
      return {
        refusal: `The field ${sum.unit_field} on the row at ${row.source.path || '/'} does not name a unit, so the sum cannot be checked. Sum rows whose unit field names a unit.`,
      };
    }
    if (unit !== undefined && rowUnit !== unit) {
      return { refusal: 'The summed rows do not share one unit. Sum rows with the same unit together.' };
    }
    unit = rowUnit;
    resultId = row.source.call_id;
    const nextScale = Math.max(scale, value.scale);
    coefficient =
      coefficient * 10n ** BigInt(nextScale - scale) + value.coefficient * 10n ** BigInt(nextScale - value.scale);
    scale = nextScale;
  }
  if (unit === undefined) {
    // The schema requires at least one ref, and every pass through the loop above either
    // returns a refusal or sets the unit, so the loop cannot end without one.
    throw new Error('unreachable');
  }
  const sign = coefficient < 0n ? '-' : '';
  const magnitude = String(coefficient < 0n ? -coefficient : coefficient).padStart(scale + 1, '0');
  const total = scale === 0 ? magnitude : `${magnitude.slice(0, -scale)}.${magnitude.slice(-scale)}`;
  return { total: sign + total, unit };
}

/**
 * Check one presentation call and render its section of the reply. Every refusal names the
 * one constraint that failed, so the model can correct the call instead of repeating it.
 * The render is person-facing: plain labels, values as ordinary text, and the connector
 * named once per group as the only provenance on the face of the answer. Source text is
 * passed through markdownText, and labels through markdownLabel, so what the reader
 * sees matches the source exactly.
 */
function renderSection(input: PresentExactValuesInput, rows: ReadonlyMap<string, ExactRow>): SectionOutcome {
  const fieldCount = input.rows.reduce((count, row) => count + row.fields.length, 0);
  if (fieldCount > MAX_FIELDS_IN_ANSWER) {
    return {
      refusal: `That call named ${String(fieldCount)} fields. One call can show at most ${String(MAX_FIELDS_IN_ANSWER)} fields. Split the rows across more calls, each one within the limit.`,
    };
  }
  const groups = new Map<string, string[]>();
  for (const selection of input.rows) {
    const row = rows.get(selection.ref);
    if (row === undefined) {
      return {
        refusal: `The row reference ${selection.ref} is not from this request. Use only the row references listed with this turn's results.`,
      };
    }
    const seen = new Set<string>();
    const entries: { label: string; value: ExactValue }[] = [];
    for (const path of selection.fields) {
      if (seen.has(path)) {
        return { refusal: `The field ${path} was named twice for one row. Name each field once.` };
      }
      seen.add(path);
      const value = row.fields.get(path);
      if (value === undefined) {
        return {
          refusal: `The row at ${row.source.path || '/'} does not carry the field ${path}. Use only the fields listed for that row.`,
        };
      }
      entries.push({ label: labelOf(path), value });
    }
    // Two different fields can read as the same label (a flat merchant_name beside a nested
    // merchant/name). When that happens in one row, number the repeated labels so the
    // reader can tell the lines apart.
    const labelCounts = new Map<string, number>();
    for (const entry of entries) {
      labelCounts.set(entry.label, (labelCounts.get(entry.label) ?? 0) + 1);
    }
    const labelSeen = new Map<string, number>();
    const lines = entries.map(entry => {
      if ((labelCounts.get(entry.label) ?? 0) < 2) {
        return `${markdownLabel(entry.label)}: ${markdownText(String(entry.value))}`;
      }
      const occurrence = (labelSeen.get(entry.label) ?? 0) + 1;
      labelSeen.set(entry.label, occurrence);
      return `${markdownLabel(entry.label)} (${String(occurrence)}): ${markdownText(String(entry.value))}`;
    });
    const group = groups.get(row.source.connector) ?? [];
    group.push(lines.join('\n'));
    groups.set(row.source.connector, group);
  }
  const blocks: string[] = [];
  for (const [connector, rowBlocks] of groups) {
    blocks.push([`Source: ${markdownText(connector)}`, ...rowBlocks].join('\n\n'));
  }
  if (input.sum !== null) {
    const summed = checkedSum(input.sum, rows, input.rows);
    if ('refusal' in summed) {
      return summed;
    }
    blocks.push(`Total: ${summed.total} ${markdownText(summed.unit)}`);
  }
  return { text: blocks.join('\n\n') };
}

/** A canonical key for one presentation call, so the same selection is recognised in any row or field order. */
function presentationKey(input: PresentExactValuesInput): string {
  const rows = input.rows
    .map(row => ({ ref: row.ref, fields: [...row.fields].sort() }))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const sum =
    input.sum === null
      ? null
      : { refs: [...input.sum.refs].sort(), value_field: input.sum.value_field, unit_field: input.sum.unit_field };
  return JSON.stringify({ rows, sum });
}

/** The rows and pending host reply live only in this request's thread. */
export class ExactSourceValues extends LocalToolMCP {
  readonly name = 'exact-source-values';
  readonly displayName = 'Exact source values';
  private readonly rows = new Map<string, ExactRow>();
  private allowedCallId: string | undefined;
  private sections: { key: string; text: string }[] = [];
  private readonly presentedKeys = new Set<string>();

  constructor(tracing: AgentTracing) {
    super({ tracing });
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: TOOL_NAME,
      description:
        'Show exact numbers or identifiers from this turn’s connector results using only existing row references and field paths. Include surrounding fields such as route, date, unit and currency. The host writes the values into the reply. Call this tool by itself. Call it again by itself to show more values, then finish with an empty message.',
      schema: PresentExactValuesSchema,
      requiresNetwork: false,
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: (input, _approval, context) => {
        if (context?.tool_call_id === undefined || context.tool_call_id !== this.allowedCallId) {
          return Promise.resolve(
            toolResultResponse({
              text: 'This tool must be the only tool call in its step. Call it again by itself.',
              isError: true,
            }),
          );
        }
        const key = presentationKey(input);
        if (this.presentedKeys.has(key)) {
          return Promise.resolve(
            toolResultResponse({
              text: 'Those values are already shown in this reply. Show other values, or finish with an empty message.',
              isError: true,
            }),
          );
        }
        const rendered = renderSection(input, this.rows);
        if ('refusal' in rendered) {
          return Promise.resolve(toolResultResponse({ text: rendered.refusal, isError: true }));
        }
        this.presentedKeys.add(key);
        this.sections.push({ key, text: rendered.text });
        return Promise.resolve(toolResultResponse({ text: PRESENTATION_ACCEPTED_TEXT }));
      },
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }

  override isHostVouchedReadTool(name: string): boolean {
    return name === TOOL_NAME;
  }

  get hasRows(): boolean {
    return this.rows.size > 0;
  }

  clear(): void {
    this.rows.clear();
    this.sections = [];
    this.presentedKeys.clear();
    this.beginBatch(undefined);
  }

  beginBatch(callId: string | undefined): void {
    this.allowedCallId = callId;
  }

  /**
   * Record the presentations this request already made, read from its persisted context,
   * so a repeated call is recognised even after an approval pause rebuilt this instance.
   */
  rememberPresentations(presentations: readonly ExactContextPresentation[]): void {
    for (const presentation of presentations) {
      if (!presentation.succeeded) {
        continue;
      }
      try {
        this.presentedKeys.add(presentationKey(PresentExactValuesSchema.parse(JSON.parse(presentation.arguments))));
      } catch {
        // A call that cannot be read back cannot be recognised here. It is still replayed,
        // and held to the exactness checks, when the reply is composed.
        continue;
      }
    }
  }

  /**
   * Adopt rows from connector results persisted in the current request's context. A request
   * that pauses for an approval resumes in a fresh instance of this class, so rows prepared
   * before the pause are rebuilt here from the stored results. The schema above only accepts
   * the complete envelope prepare() writes. The values adopted are the ones the envelope's
   * row records carry: the very values prepare() derived from the admitted result text when
   * the result arrived, so a replayed value and the row the model was shown come from that
   * one derivation, and no value is re-derived from a second stored copy of the result,
   * whose own size and digits the cap and the parse would judge differently. The plain
   * result the model read is never a source of values, because its numbers are already
   * rounded; it only confirms, through plainCopyAgrees, that each advertised field stands
   * at its path in the result with a value of the same kind.
   */
  adoptContextResults(results: readonly ExactContextResult[]): void {
    const knownCallIds = new Set([...this.rows.values()].map(row => row.source.call_id));
    for (const entry of results) {
      if (knownCallIds.has(entry.call_id)) {
        continue;
      }
      knownCallIds.add(entry.call_id);
      const replaced = replacedContentOf(entry.content);
      if (replaced === undefined) {
        continue;
      }
      for (const advertised of replaced.exact_source_rows) {
        if (this.rows.has(advertised.ref) || this.rows.size >= MAX_ROWS) {
          continue;
        }
        // prepare() writes the containing path of a direct record as '/', where the
        // row itself carries it as the empty path.
        const path = advertised.path === '/' ? '' : advertised.path;
        const kept = new Map<string, ExactValue>();
        for (const fieldPath of advertised.fields) {
          const value = advertised.values[fieldPath];
          if (value === undefined) {
            continue;
          }
          if (!plainCopyAgrees(valueAtPath(replaced.connector_result, path + fieldPath), value)) {
            continue;
          }
          kept.set(fieldPath, value);
        }
        if (kept.size === 0) {
          continue;
        }
        this.rows.set(advertised.ref, {
          ref: advertised.ref,
          source: { connector: entry.connector, tool: entry.tool, call_id: entry.call_id, path },
          fields: kept,
        });
      }
    }
  }

  /**
   * The reply the host writes for this request, in presentation order. Sections rendered by
   * this instance are used as they stand. Sections presented by an earlier instance of this
   * request (before an approval pause rebuilt the thread) are rendered again from the
   * persisted presentation calls and the adopted rows. A section that can no longer be
   * rendered exactly makes the whole reply fall back to the caller's could-not-verify note
   * (this returns undefined), rather than showing the remaining sections as if they were
   * the complete statement. A repeated presentation is shown once.
   */
  composedAnswer(presentations: readonly ExactContextPresentation[]): string | undefined {
    const successful = presentations.filter(presentation => presentation.succeeded);
    const replayCount = Math.max(0, successful.length - this.sections.length);
    const sections: string[] = [];
    const renderedKeys = new Set<string>();
    for (const presentation of successful.slice(0, replayCount)) {
      let input: PresentExactValuesInput;
      try {
        input = PresentExactValuesSchema.parse(JSON.parse(presentation.arguments));
      } catch {
        return undefined;
      }
      const key = presentationKey(input);
      if (renderedKeys.has(key)) {
        continue;
      }
      const rendered = renderSection(input, this.rows);
      if (!('text' in rendered)) {
        return undefined;
      }
      renderedKeys.add(key);
      sections.push(rendered.text);
    }
    for (const section of this.sections) {
      if (renderedKeys.has(section.key)) {
        continue;
      }
      renderedKeys.add(section.key);
      sections.push(section.text);
    }
    return sections.length === 0 ? undefined : sections.join('\n\n');
  }

  prepare(result: ToolCallResult, remaining: number): ExactRow[] {
    const info = result.toolCallInfo;
    if (
      info?.type !== 'mcp' ||
      !safeText(info.mcp_server_name) ||
      !safeText(info.original_tool_name) ||
      result.disposition !== 'executed_ok' ||
      result.failure ||
      !result.isStructuredContent ||
      result.screen?.action === 'withheld' ||
      result.outputTransform !== undefined ||
      result.message.content !== result.rawContent ||
      result.rawContent.length > MAX_SOURCE_CHARS ||
      this.rows.size + remaining >= MAX_ROWS
    ) {
      return [];
    }
    let original: unknown;
    try {
      original = JSON.parse(result.rawContent);
    } catch {
      return [];
    }
    let rowSource: unknown;
    try {
      rowSource = parseWithExactDecimals(result.rawContent);
    } catch {
      rowSource = original;
    }
    const rows = rowsOf(rowSource)
      .slice(0, MAX_ROWS - this.rows.size - remaining)
      .map(({ path, fields }) => ({
        ref: `row_${randomBytes(9).toString('base64url')}`,
        source: {
          connector: info.mcp_server_name,
          tool: info.original_tool_name,
          call_id: result.message.tool_call_id,
          path,
        },
        fields,
      }));
    if (rows.length === 0) {
      return rows;
    }
    result.message.content = JSON.stringify({
      connector_result: original,
      // Each advertised row carries the exact values this derivation produced, so a
      // request that resumes after an approval pause replays those very values. No
      // second copy of the result is stored for the replay: a copy would be measured
      // against the size cap by its own, larger serialization, and its digits could
      // disagree with the rows it is meant to vouch for.
      exact_source_rows: rows.map(row => ({
        ref: row.ref,
        path: row.source.path || '/',
        fields: [...row.fields.keys()],
        values: Object.fromEntries(row.fields),
      })),
      exact_source_instructions: EXACT_SOURCE_INSTRUCTIONS,
    });
    result.outputTransform = 'replaced';
    return rows;
  }

  commit(rows: readonly ExactRow[]): void {
    for (const row of rows) {
      this.rows.set(row.ref, row);
    }
  }
}
