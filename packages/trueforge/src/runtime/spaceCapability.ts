/**
 * A space is a persistent, named, structured page the model creates and updates through
 * `create_space` / `update_space`, reads through `list_spaces` / `get_space` (which can also read
 * a retained historical revision), restores through `revert_space`, and the UI renders
 * (see `packages/frontend/src/spaceStore.ts`). Unlike a sandbox file, a space survives the turn and
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
  SpaceRevisionNotFoundError,
  type ISpaceStore,
  type SpaceMutationResult,
  type SpaceRecord,
} from '../db/spaceStore';
import {
  SPACE_BODY_MAX_LENGTH,
  SPACE_LIST_LIMIT,
  SpaceContentSchema,
  SpaceFormatSchema,
  SpaceSchema,
} from '../schemas/space';
import { MemoryTurnResourceResolver } from './MemoryTurnResourceResolver';

export const SPACE_SERVER_ID = 'space';
export const LIST_SPACES_TOOL_NAME = 'list_spaces';
export const GET_SPACE_TOOL_NAME = 'get_space';
export const CREATE_SPACE_TOOL_NAME = 'create_space';
export const UPDATE_SPACE_TOOL_NAME = 'update_space';
export const REVERT_SPACE_TOOL_NAME = 'revert_space';

/**
 * Thrown when a delta edit's search text is not found in the current body. The error message is
 * self-contained: it states that nothing was persisted, shows the search text, and gives recovery
 * steps, so the model does not need to consult the tool description to recover.
 */
export class SpaceEditNotFoundError extends Error {
  readonly search: string;
  readonly index: number;

  constructor(input: { search: string; index: number }) {
    const preview = input.search.length > 500 ? `${input.search.slice(0, 500)}…` : input.search;
    super(
      `Edit #${String(input.index + 1)} search text not found in the space's current body. ` +
        `Nothing was persisted — the space is unchanged. ` +
        `Search text (exact, case- and whitespace-sensitive): "${preview}". ` +
        `Likely causes: whitespace or HTML-entity differences between your search text and the actual body, ` +
        `or the body changed since you last read it. ` +
        `Re-read the body with get_space and copy the search text verbatim from the fresh body, ` +
        `or fall back to a full-body update.`,
    );
    this.name = 'SpaceEditNotFoundError';
    this.search = input.search;
    this.index = input.index;
  }
}

/**
 * Thrown when a delta-edited update_space call computes a body longer than the schema's
 * character limit. A tool-layer policy, not a store error: it never reaches the database.
 * Exported alongside SpaceEditNotFoundError: both are terminal tool errors surfaced by write().
 */
export class SpaceBodyTooLongError extends Error {
  readonly space_id: string;
  readonly new_length: number;

  constructor(input: { space_id: string; new_length: number }) {
    super(
      `Refusing update_space on "${input.space_id}": the new body (${input.new_length.toLocaleString('en-US')} characters) ` +
        `exceeds the ${SPACE_BODY_MAX_LENGTH.toLocaleString('en-US')}-character limit. Nothing was persisted — the space is unchanged. ` +
        `Shorten the resulting body: use smaller replacements, or remove content with additional edits.`,
    );
    this.name = 'SpaceBodyTooLongError';
    this.space_id = input.space_id;
    this.new_length = input.new_length;
  }
}

const SPACE_INSTRUCTION_SECTION = 'spaces';
const SPACE_INSTRUCTION = `
When the user asks you to build, create, or set up a space (or a tracker, board, or page they want kept up to date, such as "build me a space for tracking houses in Spain"), call list_spaces first: if an existing space already covers the same subject, update it with update_space instead of creating a duplicate. Use get_space to read a space’s current body and revision before calling update_space. Create a new space with create_space only when no existing one fits, and keep it current with update_space as the underlying facts change. A space has a name, a purpose, a status (active or archived), a format (markdown or html), and a body; its content is host-rendered in the Spaces view, not a markdown file or a sandbox artifact, so the sandbox is not the place for it. Pass body as an array of lines, one line per element (each table row its own element, and a blank line as an empty-string element); a single string with escaped newlines is unreliable to produce and tends to collapse onto one line, breaking tables.

Choose format 'markdown' for a plain list or note, and format 'html' whenever the space is meant to be looked at rather than skimmed as a list: a tracker, board, dashboard, or anything where layout, color, or images carry meaning. An html space is one complete document fragment, and the host injects a designed base stylesheet ahead of it: a type scale, a warm neutral palette drawn from the app's own theme with one accent, a 4px spacing rhythm, and ready-made classes and elements you should write semantic HTML against rather than reinvent — .page-header (a title plus a .subtitle or a <p> for the page's own heading block), section or .card (a bordered, padded group of related content), .grid-2 or .grid-3 (lay cards side by side), table with a <thead> header row and <tbody> rows (already full width with a distinguished header row and zebra striping; the host adds class="num" to any <td> whose content is a bare number for you, or add it yourself on a cell it would miss), .badge / .badge-success / .badge-warning (small status pills), and <details> (already styled as a collapsible block). Add only a small <style> block of your own, after that markup, for page-specific touches — it applies after the base stylesheet and can override it, but the point is to need little of it. A minimal skeleton: a .page-header with the title and a one-line subtitle, one .grid-2 or .grid-3 of .card elements for key stats, one table for the tracked rows, and a <details> for anything worth tucking away — for example: \`<div class="page-header"><h1>Spain house search</h1><p class="subtitle">6 candidates, 2 viewed</p></div><div class="grid-2"><div class="card"><h3>Budget</h3><p>€450,000</p></div><div class="card"><h3>Viewed</h3><p>2 of 6</p></div></div><table><thead><tr><th>Address</th><th>Price</th><th>Status</th></tr></thead><tbody><tr><td>Calle Mayor 1</td><td>250000</td><td><span class="badge badge-success">Viewed</span></td></tr></tbody></table><details><summary>Notes</summary><p>...</p></details>\`.

Author every html space the same way you would author a standalone web artifact, built on the classes above rather than writing page chrome from scratch: one self-contained document, inline CSS, no external scripts, no external stylesheets, images as https or data URIs. \
If the web-artifacts-builder skill is mounted in this session, follow its SKILL.md design guidance as well, but do not run its bundling scripts: a space is an HTML fragment rendered by the host, not a bundled app. \
Emoji are fine in spaces: they are plain Unicode text, nothing forbids them. \
Prefer web images by https URL over data URIs: an <img src="https://..."> costs you only the URL string, because the browser fetches the bytes at render time, while a data URI embeds base64 in the HTML itself and eats context — use https image URLs when you have tools to find them or the user supplies them. \
Never author a space by editing files in the sandbox, not with apply_patch, replace_text, write_file, or exec: spaces are created and updated with create_space and update_space only. \
The host’s sanitiser decides what actually renders either way.

For a tracker (houses, tasks, candidates, or anything with several tracked items), put one row per item in a table (a markdown table for format 'markdown', a styled <table> for format 'html'), with columns for whatever the user cares about (for houses in Spain, that might be address, price, location, and viewing status).

update_space accepts either the full body or a list of search/replace edits (not both): for small changes to a large space, pass edits with search/replace pairs applied to the current body in order, instead of resending the whole body. Each search is an exact, case-sensitive, whitespace-sensitive substring match against the current body (lines joined by a single newline) — copy search text verbatim from the most recent get_space body, never from memory or a metadata-only read. Each search must match or the whole update fails and nothing is persisted; every occurrence of a search is replaced, so prefer long, unique search strings anchored with surrounding context; and each edit sees the result of the previous ones, so keep edits independent. For a full-body update, read the space’s current body first (with get_space) and resend the full body with your changes folded in. Every update keeps the previous content: get_space accepts a revision to read an older version (only recent revisions are kept), and revert_space restores one as a new current revision — use revert_space to undo a bad update rather than reconstructing the content from memory. expected_aggregate_revision and expected_revision are optional on both create_space and update_space: leave them out and the host reads the current values for you, so a plain create or update just works. Supply them yourself only when you already have them from a preceding tool result; if a value you do supply turns out stale, the error names the current one, so retry once with that value before giving up. For a full-body update, retry once with that value. For edits, the search strings were computed against the old body, so call get_space again to read the fresh body, recompute your edits against it, and then retry with the named value.
`;

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
const GET_SPACE_INPUT_SCHEMA = z
  .object({
    space_id: z.string().min(1),
    revision: z.number().int().positive().optional(),
    include_body: z.boolean().default(true),
  })
  .strict();
const CREATE_SPACE_INPUT_SCHEMA = SpaceContentSchema.extend({
  body: SPACE_BODY_INPUT_SCHEMA,
  expected_aggregate_revision: z.number().int().nonnegative().optional(),
}).strict();
const SPACE_EDIT_SCHEMA = z
  .object({
    search: z.string().min(1),
    replace: z.string(),
  })
  .strict();
/**
 * On the edits path, name/purpose/status/format are optional: omit them to leave metadata
 * unchanged, provide them to change specific fields. On the full-body path they remain required,
 * since a body replacement is a wholesale overwrite. The refines below enforce this.
 */
const UPDATE_SPACE_INPUT_SCHEMA = SpaceContentSchema.partial()
  .extend({
    body: SPACE_BODY_INPUT_SCHEMA.optional(),
    // SpaceContentSchema gives format a default('markdown') that survives .partial(): redeclare it
    // default-free so that on the edits path an omitted format parses to undefined (unchanged)
    // instead of clobbering the current format back to 'markdown'.
    format: SpaceFormatSchema.optional(),
    edits: z.array(SPACE_EDIT_SCHEMA).min(1).max(50).optional(),
    space_id: z.string().min(1),
    expected_revision: z.number().int().positive().optional(),
    expected_aggregate_revision: z.number().int().nonnegative().optional(),
    confirm_shrink: z.boolean().optional(),
  })
  .strict()
  .refine(data => (data.body !== undefined) !== (data.edits !== undefined), {
    message: 'Provide exactly one of body (full replacement) or edits (delta updates)',
  })
  .refine(
    data =>
      data.body === undefined ||
      (data.name !== undefined && data.purpose !== undefined && data.status !== undefined),
    {
      message:
        'Full-body updates replace the whole space: name, purpose, and status are all required with body ' +
        "(format defaults to 'markdown' when omitted). " +
        'With edits, omit metadata fields to leave them unchanged.',
    },
  );
const REVERT_SPACE_INPUT_SCHEMA = z
  .object({
    space_id: z.string().min(1),
    revision: z.number().int().positive(),
    expected_revision: z.number().int().positive().optional(),
    expected_aggregate_revision: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Thrown when an update_space call would shrink a space's body below a tenth of its current size
 * without explicit confirmation. A tool-layer policy, not a store error: it never reaches the
 * database.
 */
class SpaceShrinkRefusedError extends Error {
  readonly space_id: string;
  readonly current_length: number;
  readonly new_length: number;

  constructor(input: { space_id: string; current_length: number; new_length: number }) {
    super(
      `Refusing update_space on "${input.space_id}": the new body (${String(input.new_length)} characters) ` +
        `is less than a tenth of the current body (${String(input.current_length)} characters). ` +
        `A truncated or accidental write must never silently wipe a space. If you really mean to ` +
        `replace almost all of it, call update_space again with confirm_shrink: true.`,
    );
    this.name = 'SpaceShrinkRefusedError';
    this.space_id = input.space_id;
    this.current_length = input.current_length;
    this.new_length = input.new_length;
  }
}

export interface SpaceTurnAuthority {
  tenantId: string;
  userRef: string;
}

/** The narrow store surface used by the host-owned space tool set. */
export type SpaceToolStore = Pick<
  ISpaceStore,
  'createSpace' | 'updateSpace' | 'revertSpace' | 'listSpacesWithAggregate' | 'getSpace' | 'getSpaceRevision'
>;

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

/**
 * The store mutation plus tool-layer annotations for the result payload. Only the
 * update_space edits path annotates; create and revert return the mutation alone.
 */
interface WriteOutcome {
  mutation: SpaceMutationResult;
  /** Per-edit replacement counts, 1-based in message order; set only by the edits path. */
  edit_replacements?: number[];
}

function mutationResultText(result: SpaceMutationResult, edit_replacements?: number[]): string {
  return JSON.stringify({
    space: SPACE_RESULT_SCHEMA.parse(result.record),
    aggregate_revision: result.aggregate_revision,
    ...(edit_replacements === undefined ? {} : { edit_replacements }),
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
        'Read one persistent space by id: its metadata (name, purpose, status, format, revision) plus the current aggregate_revision, with the full body included unless include_body is false. Call this before update_space to read the current body and revision. Pass revision to read a retained historical revision instead of the current one (for example to inspect what a bad update overwrote). Pass include_body: false when you already have the body from a recent get_space and only need the current revision: this avoids duplicating large HTML in the prompt. include_body: false is for metadata-only reads — do not combine it with revision when you want to inspect the historical body. Use list_spaces first if you do not already have the space id.',
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
        'Update one persistent space. Provide exactly one of body or edits. ' +
        'For body (full replacement): replaces name, purpose, status, format, and body wholesale — name, purpose, and status are required (format defaults to \'markdown\' if omitted). Call get_space first to read the current values if you are changing only one field, then resend the full current body with your changes folded in. ' +
        'For edits (delta updates): a list of up to 50 search/replace pairs applied to the current body in order; use this for small changes to a large space to avoid resending the full HTML. name, purpose, status, and format are optional with edits — omit them to leave metadata unchanged, provide them to change specific fields. ' +
        'Each search is an exact, case-sensitive, whitespace-sensitive substring match against the current body (lines joined by a single newline character). Copy search text verbatim from the most recent get_space body — do not retype, reformat, or normalize it, and never compose search strings from memory or from a metadata-only read: use edits only when you have the current body from a recent get_space in this conversation. ' +
        'Each search replaces every occurrence in the body, so use long, unique search strings anchored with surrounding context — never a single common word like a status label. The result reports how many occurrences each edit replaced, so check the counts match what you intended; if they do not, call revert_space to undo. ' +
        'Edits apply sequentially, so a later edit\u2019s search sees the result of earlier edits: keep edits independent — a later edit\u2019s search must not match text produced by an earlier edit\u2019s replacement. If two changes interact, combine them into a single edit. ' +
        'If an edit\u2019s search is not found, the entire update fails and nothing is persisted. Do not retry the same edits — re-read the body with get_space (it may have changed since you last read it) and copy fresh search text, or fall back to a full-body update. ' +
        'As a safety net, an update that would shrink the body to less than a tenth of its current size is refused unless you pass confirm_shrink: true — a truncated or accidental write must never silently wipe a space. ' +
        "format 'markdown' is a plain list or note; format 'html' is a designed page: one complete document fragment, with the host's base stylesheet injected ahead of it, so write semantic HTML against its classes (.page-header, section / .card, .grid-2 / .grid-3, table with <thead>/<tbody>, .badge / .badge-success / .badge-warning, <details>) and add only a small page-specific <style> block of your own, plus images from https URLs or data URIs; no <script>, no external stylesheets, and no external fonts (the host strips all three). " +
        'Pass body as an array of lines (one line per element, table rows one per element, blank lines as empty-string elements); a single string with escaped newlines is unreliable to produce correctly. ' +
        'expected_revision and expected_aggregate_revision are optional; omit them and the host fills in the current values.',
      schema: UPDATE_SPACE_INPUT_SCHEMA,
      handler: async input => this.write(() => this.update(input)),
    }),
    defineTool({
      name: REVERT_SPACE_TOOL_NAME,
      description:
        'Restore a historical revision of a space as a new current revision. Use this to undo a bad update_space: pass the revision you want back (read it first with get_space if you are unsure), and the space’s name, purpose, status, format, and body return to exactly what they were at that revision, recorded as a new revision — the bad content stays recoverable too. expected_revision and expected_aggregate_revision are optional; omit them and the host fills in the current values.',
      schema: REVERT_SPACE_INPUT_SCHEMA,
      handler: async input => this.write(() => this.revert(input)),
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
  ): Promise<{ space: SpaceRecord; aggregate_revision: number; include_body: boolean }> {
    const identity = {
      tenant_id: this.options.authority.tenantId,
      created_by: this.options.authority.userRef,
      space_id: input.space_id,
    };
    const space =
      input.revision === undefined
        ? await this.options.store.getSpace(identity)
        : await this.options.store.getSpaceRevision({ ...identity, revision: input.revision });
    if (space === undefined) {
      if (input.revision === undefined) {
        throw new SpaceNotFoundError({ id: input.space_id });
      }
      throw new SpaceRevisionNotFoundError({ id: input.space_id, revision: input.revision });
    }
    const aggregate_revision = await resolveAggregateRevision(this.options.store, this.options.authority, undefined);
    return { space, aggregate_revision, include_body: input.include_body };
  }

  private async create(input: z.infer<typeof CREATE_SPACE_INPUT_SCHEMA>): Promise<WriteOutcome> {
    const expected_aggregate_revision = await resolveAggregateRevision(
      this.options.store,
      this.options.authority,
      input.expected_aggregate_revision,
    );
    const mutation = await this.options.store.createSpace({
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
    return { mutation };
  }

  private async update(input: z.infer<typeof UPDATE_SPACE_INPUT_SCHEMA>): Promise<WriteOutcome> {
    const [expected_aggregate_revision, current] = await Promise.all([
      resolveAggregateRevision(this.options.store, this.options.authority, input.expected_aggregate_revision),
      this.requireCurrentSpace(input.space_id),
    ]);
    // Delta updates: apply search/replace edits to the current body in order.
    // This avoids resending large HTML through the tool call. A missing search
    // fails before anything is persisted.
    let body = input.body;
    let edit_replacements: number[] | undefined;
    if (input.edits !== undefined) {
      let edited = current.body;
      edit_replacements = [];
      for (const [index, edit] of input.edits.entries()) {
        const parts: string[] = edited.split(edit.search);
        if (parts.length < 2) {
          throw new SpaceEditNotFoundError({ search: edit.search, index });
        }
        edit_replacements.push(parts.length - 1);
        // Check the resulting length arithmetically BEFORE joining: a huge
        // replace string could otherwise OOM the process building the joined
        // string before the length check ever runs. Exact under the
        // <= SPACE_BODY_MAX_LENGTH invariant every writer enforces.
        const new_length =
          edited.length + (parts.length - 1) * (edit.replace.length - edit.search.length);
        if (new_length > SPACE_BODY_MAX_LENGTH) {
          throw new SpaceBodyTooLongError({ space_id: input.space_id, new_length });
        }
        edited = parts.join(edit.replace);
      }
      body = edited;
    }
    this.checkShrink(input.space_id, current, body ?? '', input.confirm_shrink);
    const mutation = await this.options.store.updateSpace({
      tenant_id: this.options.authority.tenantId,
      created_by: this.options.authority.userRef,
      space_id: input.space_id,
      // On the edits path, omitted metadata means "unchanged": fall back to current values.
      // On the full-body path, format keeps its historical schema default ('markdown') when omitted.
      name: input.name ?? current.name,
      purpose: input.purpose ?? current.purpose,
      status: input.status ?? current.status,
      body: body ?? '',
      format: input.format ?? (input.edits !== undefined ? current.format : 'markdown'),
      expected_revision: input.expected_revision ?? current.revision,
      expected_aggregate_revision,
    });
    const outcome: WriteOutcome = { mutation };
    if (edit_replacements !== undefined) {
      outcome.edit_replacements = edit_replacements;
    }
    return outcome;
  }

  private async revert(input: z.infer<typeof REVERT_SPACE_INPUT_SCHEMA>): Promise<WriteOutcome> {
    const [expected_aggregate_revision, expected_revision] = await Promise.all([
      resolveAggregateRevision(this.options.store, this.options.authority, input.expected_aggregate_revision),
      resolveSpaceRevision(this.options.store, this.options.authority, input.space_id, input.expected_revision),
    ]);
    const mutation = await this.options.store.revertSpace({
      tenant_id: this.options.authority.tenantId,
      created_by: this.options.authority.userRef,
      space_id: input.space_id,
      revision: input.revision,
      expected_revision,
      expected_aggregate_revision,
    });
    return { mutation };
  }

  private async requireCurrentSpace(space_id: string): Promise<SpaceRecord> {
    const space = await this.options.store.getSpace({
      tenant_id: this.options.authority.tenantId,
      created_by: this.options.authority.userRef,
      space_id,
    });
    if (space === undefined) {
      throw new SpaceNotFoundError({ id: space_id });
    }
    return space;
  }

  /**
   * A truncated or accidental write must never silently wipe a space: refuse an update that would
   * shrink the body below a tenth of its current size unless the model explicitly confirms it.
   */
  private checkShrink(space_id: string, current: SpaceRecord, body: string, confirmed: boolean | undefined): void {
    if (confirmed === true || current.body.length <= 200 || body.length * 10 >= current.body.length) {
      return;
    }
    throw new SpaceShrinkRefusedError({
      space_id,
      current_length: current.body.length,
      new_length: body.length,
    });
  }

  /**
   * Only a known, expected read failure (an unknown space id or a revision outside the retained
   * window, both with a stable sanitized message) becomes a terminal tool error here. Any other
   * exception is an unexpected infrastructure or programming failure and is rethrown uncaught so
   * its exception and stack reach the tracing wrapper instead of being collapsed into an ordinary
   * nonzero tool result.
   */
  private async read(
    run: () => Promise<
      | { spaces: SpaceRecord[]; aggregate_revision: number; has_more: boolean }
      | { space: SpaceRecord; aggregate_revision: number; include_body: boolean }
    >,
  ) {
    try {
      return toolResultResponse({ text: JSON.stringify(this.toWire(await run())) });
    } catch (error) {
      if (error instanceof SpaceNotFoundError) {
        return toolResultResponse({ text: JSON.stringify({ error: this.notFoundMessage(error) }), isError: true });
      }
      if (error instanceof SpaceRevisionNotFoundError) {
        return toolResultResponse({
          text: JSON.stringify({ error: `${error.message}. Only recent revisions are retained.` }),
          isError: true,
        });
      }
      throw error;
    }
  }

  private toWire(
    result:
      | { spaces: SpaceRecord[]; aggregate_revision: number; has_more: boolean }
      | { space: SpaceRecord; aggregate_revision: number; include_body: boolean },
  ) {
    if ('spaces' in result) {
      return {
        spaces: result.spaces.map(record => SPACE_SUMMARY_SCHEMA.parse(record)),
        aggregate_revision: result.aggregate_revision,
        has_more: result.has_more,
      };
    }
    // Omit the body entirely when the caller already has it: an empty string would be
    // indistinguishable from a genuinely empty body, so follow the list_spaces pattern and
    // drop the field via SPACE_SUMMARY_SCHEMA.
    const spaceSchema = result.include_body ? SPACE_RESULT_SCHEMA : SPACE_SUMMARY_SCHEMA;
    return { space: spaceSchema.parse(result.space), aggregate_revision: result.aggregate_revision };
  }

  /**
   * Only a known, expected write failure (a stale entity or aggregate revision, an unknown space
   * id, a revision outside the retained window, a refused dramatic shrink, a delta-computed body
   * over the size limit, or a delta edit whose search text is not found, all with a stable
   * sanitized message) becomes a terminal tool error here. Any other exception is an unexpected
   * infrastructure or programming failure and is rethrown uncaught so its exception and stack
   * reach the tracing wrapper instead of being collapsed into an ordinary nonzero tool result.
   */
  private async write(run: () => Promise<WriteOutcome>) {
    try {
      const { mutation, edit_replacements } = await run();
      return toolResultResponse({ text: mutationResultText(mutation, edit_replacements) });
    } catch (error) {
      if (error instanceof SpaceNotFoundError) {
        return toolResultResponse({ text: JSON.stringify({ error: this.notFoundMessage(error) }), isError: true });
      }
      if (error instanceof SpaceRevisionNotFoundError) {
        return toolResultResponse({
          text: JSON.stringify({ error: `${error.message}. Only recent revisions are retained.` }),
          isError: true,
        });
      }
      if (error instanceof SpaceShrinkRefusedError) {
        return toolResultResponse({ text: JSON.stringify({ error: error.message }), isError: true });
      }
      if (error instanceof SpaceBodyTooLongError) {
        return toolResultResponse({ text: JSON.stringify({ error: error.message }), isError: true });
      }
      if (error instanceof SpaceEditNotFoundError) {
        return toolResultResponse({ text: JSON.stringify({ error: error.message }), isError: true });
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

/** Attaches `list_spaces` / `get_space` / `create_space` / `update_space` / `revert_space` to one turn's root thread. */
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
