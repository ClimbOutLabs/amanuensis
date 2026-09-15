/**
 * A space is a persistent, named, structured page the model creates and updates through
 * `create_space` / `update_space`, reads through `list_spaces` / `get_space`, and the UI renders
 * (see `packages/frontend/src/spaces`). Unlike a sandbox file, a space survives the turn and
 * session that created it and is visible in the Spaces view without the user opening the chat
 * that produced it.
 *
 * There is no `delete_space` tool, deliberately: the model must not be able to remove a page the
 * user is keeping. Deleting a space is a UI-only action (`DELETE /api/v1/spaces/{space_id}`,
 * exposed from the space's own page), never something a running turn can reach.
 */
import type { AgentCapability, AgentTracing, InstructionBuilder } from '@truefoundry/trueforge-core/core';
import { defineTool, LocalToolMCP, toolResultResponse, type ToolDefinition } from '@truefoundry/trueforge-core/core';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
  SpaceAggregateRevisionConflictError,
  SpaceNotFoundError,
  SpaceRevisionConflictError,
  type ISpaceStore,
  type SpaceMutationResult,
  type SpaceRecord,
} from '../db/spaceStore';
import { SPACE_LIST_LIMIT, SpaceContentSchema, SpaceSchema } from '../schemas/space';
import { MemoryTurnResourceResolver } from './MemoryTurnResourceResolver';

export const SPACE_SERVER_ID = 'space';
export const LIST_SPACES_TOOL_NAME = 'list_spaces';
export const GET_SPACE_TOOL_NAME = 'get_space';
export const CREATE_SPACE_TOOL_NAME = 'create_space';
export const UPDATE_SPACE_TOOL_NAME = 'update_space';

const SPACE_INSTRUCTION_SECTION = 'spaces';
const SPACE_INSTRUCTION =
  'When the user asks you to build, create, or set up a space (or a tracker, board, or page they want kept up to date, such as "build me a space for tracking houses in Spain"), call list_spaces first: if an existing space already covers the same subject, update it with update_space instead of creating a duplicate. Use get_space to read a space’s current body and revision before calling update_space. Create a new space with create_space only when no existing one fits, and keep it current with update_space as the underlying facts change. A space has a name, a purpose, a status (active or archived), a format (markdown or html), and a body; its content is host-rendered in the Spaces view, not a markdown file or a sandbox artifact, so the sandbox is not the place for it. Pass body as an array of lines, one line per element (each table row its own element, and a blank line as an empty-string element); a single string with escaped newlines is unreliable to produce and tends to collapse onto one line, breaking tables. Choose format \'markdown\' for a plain list or note, and format \'html\' whenever the space is meant to be looked at rather than skimmed as a list: a tracker, board, dashboard, or anything where layout, color, or images carry meaning. An html space is one complete document fragment, and the host injects a designed base stylesheet ahead of it: a type scale, a warm neutral palette drawn from the app\'s own theme with one accent, a 4px spacing rhythm, and ready-made classes and elements you should write semantic HTML against rather than reinvent — .page-header (a title plus a .subtitle or a <p> for the page\'s own heading block), section or .card (a bordered, padded group of related content), .grid-2 or .grid-3 (lay cards side by side), table with a <thead> header row and <tbody> rows (already full width with a distinguished header row and zebra striping; the host adds class="num" to any <td> whose content is a bare number for you, or add it yourself on a cell it would miss), .badge / .badge-success / .badge-warning (small status pills), and <details> (already styled as a collapsible block). Add only a small <style> block of your own, after that markup, for page-specific touches — it applies after the base stylesheet and can override it, but the point is to need little of it. A minimal skeleton: a .page-header with the title and a one-line subtitle, one .grid-2 or .grid-3 of .card elements for key stats, one table for the tracked rows, and a <details> for anything worth tucking away — for example: `<div class="page-header"><h1>Spain house search</h1><p class="subtitle">6 candidates, 2 viewed</p></div><div class="grid-2"><div class="card"><h3>Budget</h3><p>€450,000</p></div><div class="card"><h3>Viewed</h3><p>2 of 6</p></div></div><table><thead><tr><th>Address</th><th>Price</th><th>Status</th></tr></thead><tbody><tr><td>Calle Mayor 1</td><td>250000</td><td><span class="badge badge-success">Viewed</span></td></tr></tbody></table><details><summary>Notes</summary><p>...</p></details>`. If the web-artifacts-builder skill is available, use it to author the html space the same way you would author a standalone web artifact, built on the classes above rather than writing page chrome from scratch: one self-contained document, inline CSS, no external scripts, no external stylesheets, images as https or data URIs. If it is not available, still write a self-contained html page by the same rules; the host’s sanitiser decides what actually renders either way. For a tracker (houses, tasks, candidates, or anything with several tracked items), put one row per item in a table (a markdown table for format \'markdown\', a styled <table> for format \'html\'), with columns for whatever the user cares about (for houses in Spain, that might be address, price, location, and viewing status). update_space replaces the whole body, so read the space’s current body first (with get_space) and resend the full body with your changes folded in, not just the delta. expected_aggregate_revision and expected_revision are optional on both create_space and update_space: leave them out and the host reads the current values for you, so a plain create or update just works. Supply them yourself only when you already have them from a preceding tool result; if a value you do supply turns out stale, the error names the current one, so retry once with that value before giving up.';

function buildSpaceInstruction(builder: InstructionBuilder): void {
  builder.addSection(SPACE_INSTRUCTION_SECTION, SPACE_INSTRUCTION);
}

/**
 * A model reliably produces one markdown line per array element but unreliably produces embedded
 * `\n` inside a single JSON string value (observed live against gpt-oss-120b: it wrote a literal
 * space where a blank line belonged, collapsing a table onto one line). Accept either shape here,
 * at the tool boundary, and join lines into the single string the store, the HTTP wire schema, and
 * the UI all expect; nothing past this point ever sees the array form.
 */
const SPACE_BODY_INPUT_SCHEMA = z
  .union([z.string(), z.array(z.string())])
  .transform(value => (Array.isArray(value) ? value.join('\n') : value))
  .pipe(SpaceContentSchema.shape.body);

const LIST_SPACES_INPUT_SCHEMA = z.object({}).strict();
const GET_SPACE_INPUT_SCHEMA = z.object({ space_id: z.string().min(1) }).strict();
const CREATE_SPACE_INPUT_SCHEMA = SpaceContentSchema.extend({
  body: SPACE_BODY_INPUT_SCHEMA,
  expected_aggregate_revision: z.number().int().nonnegative().optional(),
}).strict();
const UPDATE_SPACE_INPUT_SCHEMA = SpaceContentSchema.extend({
  body: SPACE_BODY_INPUT_SCHEMA,
  space_id: z.string().min(1),
  expected_revision: z.number().int().positive().optional(),
  expected_aggregate_revision: z.number().int().nonnegative().optional(),
}).strict();

export interface SpaceTurnAuthority {
  tenantId: string;
  userRef: string;
}

/** The narrow store surface used by the host-owned space tool set. */
export type SpaceToolStore = Pick<ISpaceStore, 'createSpace' | 'updateSpace' | 'listSpacesWithAggregate' | 'getSpace'>;

export interface SpaceCapabilityOptions {
  store: SpaceToolStore;
  authority: SpaceTurnAuthority;
  tracing: AgentTracing;
}

/**
 * The store record carries `tenant_id` and `created_by`, host-owned scope that is never a wire
 * field (see `SpaceRecord` in `../db/spaceStore`). Parse through the wire `SpaceSchema`, relaxed
 * to strip rather than reject those extra keys, so the model only ever sees the same shape the
 * `/api/v1/spaces` routes and the UI do.
 */
const SPACE_RESULT_SCHEMA = SpaceSchema.strip();
const SPACE_SUMMARY_SCHEMA = SpaceSchema.omit({ body: true }).strip();

function mutationResultText(result: SpaceMutationResult): string {
  return JSON.stringify({
    space: SPACE_RESULT_SCHEMA.parse(result.record),
    aggregate_revision: result.aggregate_revision,
  });
}

/** Resolves the per-owner aggregate revision to fence a write with, reading the current value from the store when the caller omitted one. */
async function resolveAggregateRevision(
  store: SpaceToolStore,
  authority: SpaceTurnAuthority,
  provided: number | undefined,
): Promise<number> {
  if (provided !== undefined) {
    return provided;
  }
  const current = await store.listSpacesWithAggregate({
    tenant_id: authority.tenantId,
    created_by: authority.userRef,
    status: undefined,
    limit: 1,
  });
  return current.aggregate_revision;
}

/** Resolves the revision to fence an update with, reading the space's current revision from the store when the caller omitted one. */
async function resolveSpaceRevision(
  store: SpaceToolStore,
  authority: SpaceTurnAuthority,
  space_id: string,
  provided: number | undefined,
): Promise<number> {
  if (provided !== undefined) {
    return provided;
  }
  const space = await store.getSpace({ tenant_id: authority.tenantId, created_by: authority.userRef, space_id });
  if (space === undefined) {
    throw new SpaceNotFoundError({ id: space_id });
  }
  return space.revision;
}

class SpaceTool extends LocalToolMCP {
  readonly name = SPACE_SERVER_ID;
  readonly displayName = 'Space';

  constructor(private readonly options: SpaceCapabilityOptions) {
    super({ tracing: options.tracing });
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: LIST_SPACES_TOOL_NAME,
      description:
        'List every persistent space visible to the user, without body content: id, name, purpose, status, revision, and updated_at for each, plus the current aggregate_revision. Call this before create_space to check whether a space already covers the subject you are about to create, so you update it instead of making a duplicate. Use get_space to read one space’s full body.',
      schema: LIST_SPACES_INPUT_SCHEMA,
      handler: async () => this.read(() => this.list()),
    }),
    defineTool({
      name: GET_SPACE_TOOL_NAME,
      description:
        'Read one persistent space by id: its full content (name, purpose, status, format, body, revision) plus the current aggregate_revision. Call this before update_space to read the current body and revision, since update_space replaces the whole body. Use list_spaces first if you do not already have the space id.',
      schema: GET_SPACE_INPUT_SCHEMA,
      handler: async input => this.read(() => this.get(input)),
    }),
    defineTool({
      name: CREATE_SPACE_TOOL_NAME,
      description:
        "Create one persistent space: a named, structured page the host renders in the Spaces view and keeps until archived. Use this instead of a sandbox file whenever the user wants something durable to track or come back to; call list_spaces first to check a space for the same subject does not already exist. Set format to 'markdown' for a plain list or note, and 'html' whenever the space is meant to be looked at rather than skimmed as a list: a tracker, board, or dashboard. A markdown body is the whole content of the page (headings, lists, and tables are all fine). An html body is one complete document fragment; the host injects a designed base stylesheet ahead of it, so write semantic HTML against its classes (.page-header for the title block, section or .card for grouped content, .grid-2 / .grid-3 to lay cards side by side, table with <thead>/<tbody>, .badge / .badge-success / .badge-warning for status pills, <details> for collapsible detail) and add only a small page-specific <style> block of your own, images from https URLs or data URIs; no <script>, no external stylesheets, and no external fonts (the host strips all three). For a tracker, put one row per tracked item in a table (markdown table, or a styled <table> for html) with the columns the user cares about. Pass body as an array of lines (one line per element, table rows one per element, blank lines as empty-string elements); a single string with escaped newlines is unreliable to produce correctly. expected_aggregate_revision is optional; omit it and the host fills in the current value.",
      schema: CREATE_SPACE_INPUT_SCHEMA,
      handler: async input => this.write(() => this.create(input)),
    }),
    defineTool({
      name: UPDATE_SPACE_TOOL_NAME,
      description:
        "Update one persistent space with its full new content. Replaces name, purpose, status, format, and body; call get_space first to read the current values if you are changing only one field. The body is replaced wholesale, so resend the full current body with your changes folded in, not just the delta. format 'markdown' is a plain list or note; format 'html' is a designed page: one complete document fragment, with the host's base stylesheet injected ahead of it, so write semantic HTML against its classes (.page-header, section / .card, .grid-2 / .grid-3, table with <thead>/<tbody>, .badge / .badge-success / .badge-warning, <details>) and add only a small page-specific <style> block of your own, plus images from https URLs or data URIs; no <script>, no external stylesheets, and no external fonts (the host strips all three). Pass body as an array of lines (one line per element, table rows one per element, blank lines as empty-string elements); a single string with escaped newlines is unreliable to produce correctly. expected_revision and expected_aggregate_revision are optional; omit them and the host fills in the current values.",
      schema: UPDATE_SPACE_INPUT_SCHEMA,
      handler: async input => this.write(() => this.update(input)),
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }

  private async list(): Promise<{ spaces: SpaceRecord[]; aggregate_revision: number; has_more: boolean }> {
    const result = await this.options.store.listSpacesWithAggregate({
      tenant_id: this.options.authority.tenantId,
      created_by: this.options.authority.userRef,
      status: undefined,
      limit: SPACE_LIST_LIMIT,
    });
    return { spaces: result.records, aggregate_revision: result.aggregate_revision, has_more: result.has_more };
  }

  private async get(
    input: z.infer<typeof GET_SPACE_INPUT_SCHEMA>,
  ): Promise<{ space: SpaceRecord; aggregate_revision: number }> {
    const space = await this.options.store.getSpace({
      tenant_id: this.options.authority.tenantId,
      created_by: this.options.authority.userRef,
      space_id: input.space_id,
    });
    if (space === undefined) {
      throw new SpaceNotFoundError({ id: input.space_id });
    }
    const aggregate_revision = await resolveAggregateRevision(this.options.store, this.options.authority, undefined);
    return { space, aggregate_revision };
  }

  private async create(input: z.infer<typeof CREATE_SPACE_INPUT_SCHEMA>): Promise<SpaceMutationResult> {
    const expected_aggregate_revision = await resolveAggregateRevision(
      this.options.store,
      this.options.authority,
      input.expected_aggregate_revision,
    );
    return await this.options.store.createSpace({
      tenant_id: this.options.authority.tenantId,
      created_by: this.options.authority.userRef,
      id: ulid().toLowerCase(),
      name: input.name,
      purpose: input.purpose,
      status: input.status,
      body: input.body,
      format: input.format,
      expected_aggregate_revision,
    });
  }

  private async update(input: z.infer<typeof UPDATE_SPACE_INPUT_SCHEMA>): Promise<SpaceMutationResult> {
    const [expected_aggregate_revision, expected_revision] = await Promise.all([
      resolveAggregateRevision(this.options.store, this.options.authority, input.expected_aggregate_revision),
      resolveSpaceRevision(this.options.store, this.options.authority, input.space_id, input.expected_revision),
    ]);
    return await this.options.store.updateSpace({
      tenant_id: this.options.authority.tenantId,
      created_by: this.options.authority.userRef,
      space_id: input.space_id,
      name: input.name,
      purpose: input.purpose,
      status: input.status,
      body: input.body,
      format: input.format,
      expected_revision,
      expected_aggregate_revision,
    });
  }

  /**
   * Only a known, expected read failure (an unknown space id, with a stable sanitized message)
   * becomes a terminal tool error here. Any other exception is an unexpected infrastructure or
   * programming failure and is rethrown uncaught so its exception and stack reach the tracing
   * wrapper instead of being collapsed into an ordinary nonzero tool result.
   */
  private async read(
    run: () => Promise<
      | { spaces: SpaceRecord[]; aggregate_revision: number; has_more: boolean }
      | { space: SpaceRecord; aggregate_revision: number }
    >,
  ) {
    try {
      return toolResultResponse({ text: JSON.stringify(this.toWire(await run())) });
    } catch (error) {
      if (error instanceof SpaceNotFoundError) {
        return toolResultResponse({ text: JSON.stringify({ error: this.notFoundMessage(error) }), isError: true });
      }
      throw error;
    }
  }

  private toWire(
    result:
      | { spaces: SpaceRecord[]; aggregate_revision: number; has_more: boolean }
      | { space: SpaceRecord; aggregate_revision: number },
  ) {
    if ('spaces' in result) {
      return {
        spaces: result.spaces.map(record => SPACE_SUMMARY_SCHEMA.parse(record)),
        aggregate_revision: result.aggregate_revision,
        has_more: result.has_more,
      };
    }
    return { space: SPACE_RESULT_SCHEMA.parse(result.space), aggregate_revision: result.aggregate_revision };
  }

  /**
   * Only a known, expected write failure (a stale entity or aggregate revision, or an unknown
   * space id, all with a stable sanitized message) becomes a terminal tool error here. Any other
   * exception is an unexpected infrastructure or programming failure and is rethrown uncaught so
   * its exception and stack reach the tracing wrapper instead of being collapsed into an ordinary
   * nonzero tool result.
   */
  private async write(run: () => Promise<SpaceMutationResult>) {
    try {
      return toolResultResponse({ text: mutationResultText(await run()) });
    } catch (error) {
      if (error instanceof SpaceNotFoundError) {
        return toolResultResponse({ text: JSON.stringify({ error: this.notFoundMessage(error) }), isError: true });
      }
      if (error instanceof SpaceRevisionConflictError) {
        return toolResultResponse({
          text: JSON.stringify({ error: error.message, revision: error.actual_revision }),
          isError: true,
        });
      }
      if (error instanceof SpaceAggregateRevisionConflictError) {
        return toolResultResponse({
          text: JSON.stringify({ error: error.message, aggregate_revision: error.actual_revision }),
          isError: true,
        });
      }
      throw error;
    }
  }

  private notFoundMessage(error: SpaceNotFoundError): string {
    return `${error.message}. Call list_spaces to find the space id.`;
  }

  override async toolCallInfo(
    params: Parameters<LocalToolMCP['toolCallInfo']>[0],
    resolveUnderlyingTool?: boolean,
  ): Promise<Awaited<ReturnType<LocalToolMCP['toolCallInfo']>>> {
    const info = await super.toolCallInfo(params, resolveUnderlyingTool);
    const isRead = params.name === LIST_SPACES_TOOL_NAME || params.name === GET_SPACE_TOOL_NAME;
    return {
      ...info,
      effect: isRead ? 'inspect' : 'edit',
      read_only_hint: isRead,
      destructive_hint: false,
      open_world_hint: false,
    };
  }
}

/** Attaches `list_spaces` / `get_space` / `create_space` / `update_space` to one turn's root thread. */
export function spaceCapability(options: SpaceCapabilityOptions): AgentCapability {
  return {
    systemToolSets: [new SpaceTool(options)],
    instructionBuilders: [buildSpaceInstruction],
  };
}

export interface SpaceTurnContext {
  store: SpaceToolStore;
  authority: SpaceTurnAuthority;
}

/**
 * Adds the space tools after memory resolution, the same root-thread-only gate the memory and
 * tool-output-screen capabilities use: a child agent's thread is not what the user opens the
 * Spaces view to see, so it gets no space tools of its own.
 */
export class SpaceTurnResourceResolver extends MemoryTurnResourceResolver {
  constructor(...args: [...ConstructorParameters<typeof MemoryTurnResourceResolver>, space: SpaceTurnContext]) {
    const [deps, personalization, persona, memory, toolOutputScreen, space] = args;
    super(deps, personalization, persona, memory, toolOutputScreen);
    this.#space = space;
  }

  readonly #space: SpaceTurnContext;

  override async resolveAgentDefinition(input: Parameters<MemoryTurnResourceResolver['resolveAgentDefinition']>[0]) {
    const resolved = await super.resolveAgentDefinition(input);
    const isSubAgent = input.agent_info !== undefined;
    if (isSubAgent) {
      return resolved;
    }
    return {
      ...resolved,
      extraCapabilities: [
        ...(resolved.extraCapabilities ?? []),
        spaceCapability({ ...this.#space, tracing: input.tracing }),
      ],
    };
  }
}
