import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ToolCallResult } from '../mcp/executeToolCalls';
import { toolResultResponse } from '../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../mcp/LocalToolMCP';
import type { AgentTracing } from '../tracing/AgentTracing';
import { isRecord } from '../util/records';

const TOOL_NAME = 'present_exact_values';
const MAX_ROWS = 50;
const MAX_FIELDS = 24;
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
    .max(12)
    .describe('Rows and field paths from the exact_source_rows list on this turn’s connector results.'),
  sum: z
    .strictObject({
      refs: z.array(RowReference).min(1).max(12),
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

function childPath({ path, key }: { path: string; key: string }): string {
  return `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function safeText(value: string): boolean {
  return value.length > 0 && value.length <= MAX_FIELD_CHARS && !CONTROL.test(value);
}

function scalar(value: unknown): ExactValue | undefined {
  if (typeof value === 'string') return safeText(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  // Numbers already parsed by the connector may have lost digits. Whole numbers are exact in this range.
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return undefined;
}

/** Collect leaf fields within one row. Arrays are different rows, never siblings to merge. */
function fieldsOf(record: Record<string, unknown>): Map<string, ExactValue> {
  const fields = new Map<string, ExactValue>();
  function visit(value: unknown, path: string, depth: number): void {
    if (fields.size >= MAX_FIELDS || depth > MAX_RECORD_DEPTH || path.length > MAX_FIELD_CHARS) return;
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (safeText(key)) visit(child, childPath({ path, key }), depth + 1);
      }
      return;
    }
    const valueToShow = scalar(value);
    if (valueToShow !== undefined) fields.set(path, valueToShow);
  }
  visit(record, '', 0);
  return fields;
}

function rowsOf(value: unknown): Array<{ path: string; fields: Map<string, ExactValue> }> {
  const rows: Array<{ path: string; fields: Map<string, ExactValue> }> = [];
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
    )
      return;
    if (Array.isArray(value)) {
      for (const [index, member] of value.entries()) {
        if (rows.length >= MAX_ROWS || visitedNodes >= MAX_VISITED_NODES) break;
        const rowPath = childPath({ path, key: String(index) });
        if (isRecord(member) && rowPath.length <= MAX_FIELD_CHARS) add(fieldsOf(member), rowPath);
        visit(member, rowPath, depth + 1);
      }
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (safeText(key)) visit(child, childPath({ path, key }), depth + 1);
      }
    }
  }
  visit(value, '', 0);
  // Direct structured records have no containing array.
  if (rows.length === 0 && isRecord(value)) add(fieldsOf(value), '');
  return rows;
}

function inlineCode(text: string): string {
  const delimiter = '`'.repeat(1 + Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length)));
  const pad = /^[ `]|[ `]$/.test(text) ? ' ' : '';
  return `${delimiter}${pad}${text}${pad}${delimiter}`;
}

function decimal(value: ExactValue | undefined): { coefficient: bigint; scale: number } | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value);
  if (!DECIMAL.test(text)) return undefined;
  const scale = text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
  return { coefficient: BigInt(text.replace('.', '')), scale };
}

function totalOf(
  input: NonNullable<PresentExactValuesInput['sum']>,
  rows: ReadonlyMap<string, ExactRow>,
): { total: string; unit: string } | undefined {
  if (
    new Set(input.refs).size !== input.refs.length ||
    input.value_field === input.unit_field ||
    input.value_field.slice(0, input.value_field.lastIndexOf('/')) !==
      input.unit_field.slice(0, input.unit_field.lastIndexOf('/'))
  ) {
    return undefined;
  }
  let unit: string | undefined;
  let resultId: string | undefined;
  let coefficient = 0n;
  let scale = 0;
  for (const ref of input.refs) {
    const row = rows.get(ref);
    const value = decimal(row?.fields.get(input.value_field));
    const rowUnit = row?.fields.get(input.unit_field);
    if (
      row === undefined ||
      value === undefined ||
      typeof rowUnit !== 'string' ||
      rowUnit.trim() === '' ||
      (unit !== undefined && rowUnit !== unit) ||
      (resultId !== undefined && row.source.call_id !== resultId)
    ) {
      return undefined;
    }
    unit = rowUnit;
    resultId = row.source.call_id;
    const nextScale = Math.max(scale, value.scale);
    coefficient =
      coefficient * 10n ** BigInt(nextScale - scale) + value.coefficient * 10n ** BigInt(nextScale - value.scale);
    scale = nextScale;
  }
  if (unit === undefined) return undefined;
  const sign = coefficient < 0n ? '-' : '';
  const magnitude = String(coefficient < 0n ? -coefficient : coefficient).padStart(scale + 1, '0');
  const total = scale === 0 ? magnitude : `${magnitude.slice(0, -scale)}.${magnitude.slice(-scale)}`;
  return { total: sign + total, unit };
}

function answerFor(input: PresentExactValuesInput, rows: ReadonlyMap<string, ExactRow>): string | undefined {
  if (input.rows.reduce((count, row) => count + row.fields.length, 0) > MAX_FIELDS_IN_ANSWER) return undefined;
  const sections: string[] = [];
  for (const selection of input.rows) {
    const row = rows.get(selection.ref);
    if (row === undefined || new Set(selection.fields).size !== selection.fields.length) return undefined;
    const source = [row.source.connector, row.source.tool, row.source.path || '/'].map(inlineCode).join(' · ');
    const lines = [`Source — ${source}`];
    for (const path of selection.fields) {
      const value = row.fields.get(path);
      if (value === undefined) return undefined;
      const label = path
        .slice(1)
        .replaceAll('/', ' › ')
        .replaceAll('~1', '/')
        .replaceAll('~0', '~')
        .replaceAll('_', ' ');
      lines.push(`- ${inlineCode(label)} — ${inlineCode(String(value))}`);
    }
    sections.push(lines.join('\n'));
  }
  const sum = input.sum;
  if (sum !== null) {
    // Every operand is visible with its provenance in the same answer.
    const selectionByRef = new Map(input.rows.map(selection => [selection.ref, selection.fields]));
    if (
      sum.refs.some(ref => {
        const fields = selectionByRef.get(ref);
        return !fields?.includes(sum.value_field) || !fields.includes(sum.unit_field);
      })
    ) {
      return undefined;
    }
    const computed = totalOf(sum, rows);
    if (computed === undefined) return undefined;
    sections.push(`**Total** — ${inlineCode(computed.total)} ${inlineCode(computed.unit)}`);
  }
  return sections.join('\n\n');
}

/** The rows and pending host reply live only in this request's thread. */
export class ExactSourceValues extends LocalToolMCP {
  readonly name = 'exact-source-values';
  readonly displayName = 'Exact source values';
  private readonly rows = new Map<string, ExactRow>();
  private allowedCallId: string | undefined;
  private answer: string | undefined;

  constructor(tracing: AgentTracing) {
    super({ tracing });
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: TOOL_NAME,
      description:
        'Finish a reply that needs exact numbers or identifiers using only existing row references and field paths. Include surrounding fields such as route, date, unit and currency. The host writes the reply. Call this tool by itself and leave the message text empty.',
      schema: PresentExactValuesSchema,
      requiresNetwork: false,
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: (input, _approval, context) => {
        const answer =
          context?.tool_call_id === undefined || context.tool_call_id !== this.allowedCallId
            ? undefined
            : answerFor(input, this.rows);
        if (answer === undefined) {
          return Promise.resolve(
            toolResultResponse({
              text: 'These values could not be checked together. Use fields from this request and retry this tool by itself.',
              isError: true,
            }),
          );
        }
        this.answer = answer;
        return Promise.resolve(toolResultResponse({ text: 'Ready to display the selected source values.' }));
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
    this.beginBatch(undefined);
  }

  beginBatch(callId: string | undefined): void {
    this.allowedCallId = callId;
    this.answer = undefined;
  }

  takeAnswer(): string | undefined {
    const answer = this.answer;
    this.beginBatch(undefined);
    return answer;
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
    const rows = rowsOf(original)
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
    if (rows.length === 0) return rows;
    result.message.content = JSON.stringify({
      connector_result: original,
      exact_source_rows: rows.map(row => ({
        ref: row.ref,
        path: row.source.path || '/',
        fields: [...row.fields.keys()],
      })),
      exact_source_instructions:
        'For a reply reporting exact values from these rows, call present_exact_values by itself. Select row references and field paths. Leave assistant text empty; the host renders the answer.',
    });
    result.outputTransform = 'replaced';
    return rows;
  }

  commit(rows: readonly ExactRow[]): void {
    for (const row of rows) this.rows.set(row.ref, row);
  }
}
