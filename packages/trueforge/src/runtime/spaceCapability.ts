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
import type { AgentCapability, AgentTracing, InstructionBuilder, Sandbox } from '@truefoundry/trueforge-core/core';
import {
  createSentinelHostContext,
  defineTool,
  extractErrorLogFields,
  LocalToolMCP,
  toolResultResponse,
  type ToolDefinition,
} from '@truefoundry/trueforge-core/core';
import type { GoogleConnectionStore } from '@truefoundry/trueforge-core/core/google/connection';
import { ulid } from 'ulid';
import type { Logger } from 'winston';
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
import { toolImagesCapability, type ToolImagesOptions } from './chatImages/toolImagesCapability';
import { gmailCapability, sandboxAttachmentStager } from './gmailCapability';
import { mapsCapability } from './mapsCapability';
import { MemoryTurnResourceResolver } from './MemoryTurnResourceResolver';

export const SPACE_SERVER_ID = 'space';
export const LIST_SPACES_TOOL_NAME = 'list_spaces';
export const GET_SPACE_TOOL_NAME = 'get_space';
export const CREATE_SPACE_TOOL_NAME = 'create_space';
export const UPDATE_SPACE_TOOL_NAME = 'update_space';
export const REVERT_SPACE_TOOL_NAME = 'revert_space';
export const LIST_BLOCKS_TOOL_NAME = 'list_blocks';

/**
 * Server-assigned anchor for the implicit whole-body block of a space that declares no
 * `<!-- @block:… -->` markers. The id is a constant, so it is stable by construction: the same
 * across turns, compactions, and revisions, with nothing to persist. `block_edits` against it
 * replaces (or, with empty new_content, deletes) the entire body, subject to the usual
 * shrink guard.
 */
export const AUTO_BLOCK_ANCHOR = 'auto-body';

/**
 * Thrown when a delta edit's search text is not found in the current body. The error message is
 * self-contained: it states that nothing was persisted, shows the search text, and steers away
 * from delta retries — a miss means the model's mental copy of the body diverged, and recomputed
 * search text does not converge. The only recovery is a full-body update.
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
        `Do not retry this search and do not recompute search text from another read: delta retries ` +
        `after a miss do not converge. Send the full updated body via update_space instead — ` +
        `call get_space first if you no longer have the current body, then pass body, not edits.`,
    );
    this.name = 'SpaceEditNotFoundError';
    this.search = input.search;
    this.index = input.index;
  }
}

/**
 * Base class for block-anchor addressing failures on the update_space block_edits path. Like
 * SpaceEditNotFoundError, these are terminal tool errors: nothing is persisted, and the message
 * lists the valid anchors so the model can address a real block (or fall back to a full-body
 * update) instead of guessing.
 */
export class SpaceBlockAnchorError extends Error {
  readonly space_id: string;
  readonly anchor: string;
  readonly index: number;
  readonly validAnchors: string[];

  constructor(input: { space_id: string; anchor: string; index: number; validAnchors: string[] }) {
    // The anchor is model-controlled: truncate it in the message the way search text is
    // truncated in SpaceEditNotFoundError, so a pathological anchor can't bloat the error
    // (and the context) unboundedly. The full value stays on the `anchor` field.
    const anchorPreview = input.anchor.length > 120 ? `${input.anchor.slice(0, 120)}…` : input.anchor;
    super(
      `${input.anchor === '' ? 'Empty' : `Unknown`} block anchor "${anchorPreview}" ` +
        `in block_edits entry #${String(input.index + 1)} for space "${input.space_id}". ` +
        `Nothing was persisted — the space is unchanged. ` +
        `Valid anchors: ${input.validAnchors.map(a => `"${a}"`).join(', ')}. ` +
        `Retry block_edits with one of the valid anchors, or send the full updated body via ` +
        `update_space (body, not block_edits).`,
    );
    this.name = 'SpaceBlockAnchorError';
    this.space_id = input.space_id;
    this.anchor = input.anchor;
    this.index = input.index;
    this.validAnchors = input.validAnchors;
  }
}

/** The anchor named no block at all. Lists the valid anchors for a converging retry. */
export class SpaceBlockAnchorNotFoundError extends SpaceBlockAnchorError {
  constructor(input: { space_id: string; anchor: string; index: number; validAnchors: string[] }) {
    super(input);
    this.name = 'SpaceBlockAnchorNotFoundError';
  }
}

/**
 * The anchor named two or more blocks: addressing it would silently pick one, so the update
 * fails closed instead. The model renames the duplicates with a full-body update.
 */
export class SpaceBlockAnchorDuplicateError extends SpaceBlockAnchorError {
  readonly occurrences: number;

  constructor(input: { space_id: string; anchor: string; index: number; occurrences: number; validAnchors: string[] }) {
    super(input);
    this.name = 'SpaceBlockAnchorDuplicateError';
    this.occurrences = input.occurrences;
    // The duplicated anchor itself is not "currently unique": listing it there sent the
    // model back to the anchor that just failed.
    const unique = input.validAnchors.filter(a => a !== input.anchor);
    const uniqueList =
      unique.length > 0 ? unique.map(a => `"${a}"`).join(', ') : '(none — every anchor in this space is duplicated)';
    this.message =
      `Block anchor "${input.anchor}" appears ${String(input.occurrences)} times in the body of ` +
      `space "${input.space_id}" (block_edits entry #${String(input.index + 1)}): block_edits needs ` +
      `a unique anchor, so nothing was persisted — the space is unchanged. ` +
      `Rename the duplicate anchors with a full-body update_space (body, not block_edits), then retry. ` +
      `Currently unique anchors: ${uniqueList}.`;
  }
}

/**
 * Thrown when delta updates (edits or block_edits) are attempted on a space whose delta mode the
 * server locked after consecutive failed delta updates. Terminal: the model must send a
 * full-body update or revert_space, either of which unlocks delta mode on success.
 */
export class SpaceDeltaLockedError extends Error {
  readonly space_id: string;

  constructor(input: { space_id: string }) {
    super(
      `Delta updates for space "${input.space_id}" are locked after consecutive failed delta ` +
        `updates in this session. Nothing was persisted — the space is unchanged. ` +
        `Do not call update_space with edits or block_edits again for this space. ` +
        `Send the full updated body via update_space (body, not edits), or restore a known-good ` +
        `revision with revert_space; a successful full-body update or revert unlocks delta updates.`,
    );
    this.name = 'SpaceDeltaLockedError';
    this.space_id = input.space_id;
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

update_space accepts exactly one of the full body, a list of search/replace edits, or a list of block_edits (never two at once): for small changes to a large space, pass edits with search/replace pairs applied to the current body in order, instead of resending the whole body. Each search is an exact, case-sensitive, whitespace-sensitive substring match against the current body (lines joined by a single newline) — copy search text verbatim from the most recent get_space body, never from memory or a metadata-only read. Each search must match or the whole update fails and nothing is persisted; every occurrence of a search is replaced, so prefer long, unique search strings anchored with surrounding context; and each edit sees the result of the previous ones, so keep edits independent. If an edit’s search is not found, do not recompute search text and do not retry the edits: send the full updated body instead. After DELTA_BREAKER_TRIP_AFTER_FAILURES consecutive failed delta updates on one space, delta updates lock for the session — further edits or block_edits are refused until a successful full-body update or revert_space unlocks them.

The reliable delta path is block_edits: delimit the independently-updated sections of a space with \`<!-- @block:name -->\` markers (valid in both html and markdown bodies; anchor names are case-sensitive, so prefer short kebab-case like \`pricing-table\`). Each marker starts a block whose content runs to the next marker or the end of the body. A \`<!-- @block:… -->\` marker inside a fenced code block (\`\`\` / ~~~) or a <pre>/<code> element is documentation text, not a block — it can never be addressed by block_edits. A block_edits entry names the anchor and supplies the block’s complete new content — you generate the new content instead of reproducing old text, so there is nothing to mis-copy; pass an empty new_content to delete the block, and new \`<!-- @block:… -->\` markers inside new_content split the block. An unknown or duplicated anchor fails the whole update and the error lists the valid anchors. A space with no markers has one implicit block named "auto-body" covering the whole body. After a context compaction, call list_blocks (not get_space) to recover the current anchors with an 80-character preview of each block, then edit by anchor; list_blocks also reports the preamble (text before the first marker), which is not addressable by anchor and is edited via a full-body update when needed. For a full-body update, read the space’s current body first (with get_space) and resend the full body with your changes folded in. Every update keeps the previous content: get_space accepts a revision to read an older version (only recent revisions are kept), and revert_space restores one as a new current revision — use revert_space to undo a bad update rather than reconstructing the content from memory. expected_aggregate_revision and expected_revision are optional on both create_space and update_space: leave them out and the host reads the current values for you, so a plain create or update just works. Supply them yourself only when you already have them from a preceding tool result; if a value you do supply turns out stale, the error names the current one, so retry once with that value before giving up. For a full-body update, retry once with that value. On the edits path, a stale revision means the body moved under you: do not retry the edits, send the full updated body instead.
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
 * One anchor-addressed delta update: `anchor` names a `<!-- @block:name -->` marker in the
 * current body (or "auto-body" for a space with no markers) and `new_content` replaces that
 * block's content wholesale. Empty `new_content` deletes the block.
 */
const SPACE_BLOCK_EDIT_SCHEMA = z
  .object({
    // Anchors are short kebab-case names by convention; the max bounds how much
    // model-controlled text can flow into error messages.
    anchor: z.string().min(1).max(200),
    new_content: z.string(),
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
    block_edits: z.array(SPACE_BLOCK_EDIT_SCHEMA).min(1).max(50).optional(),
    space_id: z.string().min(1),
    expected_revision: z.number().int().positive().optional(),
    expected_aggregate_revision: z.number().int().nonnegative().optional(),
    confirm_shrink: z.boolean().optional(),
  })
  .strict()
  .refine(data => [data.body, data.edits, data.block_edits].filter(value => value !== undefined).length === 1, {
    message:
      'Provide exactly one of body (full replacement), edits (search/replace delta updates), or block_edits (anchor-addressed delta updates)',
  })
  .refine(
    data =>
      data.body === undefined || (data.name !== undefined && data.purpose !== undefined && data.status !== undefined),
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
const LIST_BLOCKS_INPUT_SCHEMA = z
  .object({
    space_id: z.string().min(1),
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
  /**
   * Chat session id. When provided, the consecutive-delta-failure breaker is keyed per
   * (tenant, user, session, space) in process-wide state, so it survives turn boundaries and
   * context compactions — the loop it stops spans turns. When omitted (tests, ad-hoc callers),
   * the breaker is scoped to this SpaceTool instance.
   */
  sessionId?: string;
  /** Operational log for delta-edit failures: the next burn loop should be visible at failure #2. */
  logger?: Logger;
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
 * update_space delta paths annotate; create, full-body update, and revert return the mutation
 * alone.
 */
interface WriteOutcome {
  mutation: SpaceMutationResult;
  /** Per-edit replacement counts, 1-based in message order; set only by the edits path. */
  edit_replacements?: number[];
  /**
   * Per-block outcomes, in message order; set only by the block_edits path. `new_length` is the
   * block's content length after the edit (0 when deleted) — the verification signal that
   * replaces replacement counts for anchor-addressed edits.
   */
  block_results?: { anchor: string; new_length: number; deleted: boolean }[];
}

function mutationResultText(result: SpaceMutationResult, outcome: Omit<WriteOutcome, 'mutation'>): string {
  return JSON.stringify({
    space: SPACE_RESULT_SCHEMA.parse(result.record),
    aggregate_revision: result.aggregate_revision,
    ...(outcome.edit_replacements === undefined ? {} : { edit_replacements: outcome.edit_replacements }),
    ...(outcome.block_results === undefined ? {} : { block_results: outcome.block_results }),
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

/**
 * Consecutive-failure circuit breaker for delta updates. A missed search/replace (or a bad
 * block anchor) means the model's mental copy of the body diverged; recomputed deltas do not
 * converge, and each retry burns a full model step — the failure loop that motivated this.
 * After DELTA_BREAKER_TRIP_AFTER_FAILURES consecutive failed delta updates on one
 * (tenant, user, session, space), delta mode locks: further edits/block_edits are refused with
 * SpaceDeltaLockedError until a successful full-body update_space or revert_space. Any success
 * resets the counter.
 *
 * The map is process-wide so the breaker survives turn boundaries and context compactions,
 * which is exactly when the loop is most expensive. Callers without a session id (tests)
 * get a per-SpaceTool-instance scope instead, via a unique instance key.
 */
interface DeltaBreakerEntry {
  failures: number;
  locked: boolean;
}
const DELTA_BREAKER_TRIP_AFTER_FAILURES = 3;
/** Bound on breaker entries: an abandoned lock must not grow memory without limit. */
const DELTA_BREAKER_MAX_ENTRIES = 5000;
const deltaBreaker = new Map<string, DeltaBreakerEntry>();
let deltaBreakerInstanceCounter = 0;

/** Separator for breaker key segments: none of tenant id, user ref, session key, or space id can contain NUL. */
const BREAKER_KEY_SEPARATOR = '\u0000';
function deltaBreakerKey(parts: { authority: SpaceTurnAuthority; sessionKey: string; spaceId: string }): string {
  return [parts.authority.tenantId, parts.authority.userRef, parts.sessionKey, parts.spaceId].join(
    BREAKER_KEY_SEPARATOR,
  );
}

/** One addressable block of a space body: the content between one marker and the next. */
interface ParsedSpaceBlock {
  anchor: string;
  /** Index of the `<` opening the `<!-- @block:… -->` marker. */
  markerStart: number;
  /** Index just past the marker's closing `-->`: where replaceable content starts. */
  contentStart: number;
  /** Index of the next marker's `<`, or body.length for the last block. */
  contentEnd: number;
}

/** Result of the list_blocks tool: block anchors plus the non-addressable preamble. */
export interface ListBlocksResult {
  space_id: string;
  revision: number;
  /**
   * Text before the first marker. Not addressable by anchor — there is no marker to hang an
   * edit on — so it is surfaced here (preview + length) for the post-compaction recovery
   * journey and edited via a full-body update_space (body, not block_edits) when needed.
   * Null when the body starts with a marker or has no markers at all (the implicit
   * whole-body block then covers everything).
   */
  preamble: { preview: string; char_count: number } | null;
  blocks: { anchor: string; preview: string; occurrences: number }[];
}

/**
 * Block anchor markers: `<!-- @block:name -->`, valid in html and markdown bodies alike.
 * Anchor names are case-sensitive; keep them short kebab-case. Deliberately no parsing beyond
 * this regex — the model authors the markers as plain comments.
 *
 * The name class keeps whitespace OUT of the repeated groups on purpose: the trailing `\s*`
 * is the only whitespace consumer, and internal spaces are matched by a separate
 * `(?: +…)*` group whose character classes are disjoint from it. Overlapping `\s*`-style
 * quantifiers here caused polynomial backtracking (tens of seconds on a near-limit body
 * with an unclosed marker), so keep the classes disjoint if this pattern ever changes.
 */
const BLOCK_ANCHOR_PATTERN = /<!--\s*@block:\s*([A-Za-z0-9][A-Za-z0-9_.-]*(?: +[A-Za-z0-9][A-Za-z0-9_.-]*)*)\s*-->/g;

/**
 * Masks regions of a body where a literal `<!-- @block:… -->` is documentation text, not a
 * structural marker: fenced code blocks (``` / ~~~) and <pre>/<code> elements. Masked
 * characters become spaces, so offsets into the masked body match the original body and the
 * marker regex can run on it directly.
 *
 * This is fail-closed by construction: without masking, a fenced sample documenting the
 * marker syntax would parse as a real addressable block, and a block_edits call could
 * silently destroy everything after it — the exact fail-open class the reliability work
 * exists to eliminate. An unclosed fence or tag masks to the end of the body.
 *
 * Single O(n) line pass with indexOf-based tag counting: no nested quantifiers, so this
 * cannot reintroduce the backtracking the anchor pattern was fixed for.
 */
function maskDocumentationRegions(body: string): string {
  const lines = body.split('\n');
  let fence: { char: string; minLength: number } | null = null;
  let tagDepth = 0;
  const masked = lines.map(line => {
    const lower = line.toLowerCase();
    let isCode = fence !== null || tagDepth > 0;

    // Fenced code blocks: ``` or ~~~, up to 3 leading spaces (CommonMark). An info string
    // is allowed on the opening line; the closing line is the fence alone.
    const fenceOpen = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    let closedFence = false;
    if (fenceOpen !== null) {
      const sequence: string = fenceOpen[1] ?? '';
      const char = sequence.charAt(0);
      if (fence === null) {
        fence = { char, minLength: sequence.length };
        isCode = true;
      } else if (char === fence.char) {
        // Closing line: the same fence character, at least as long, and nothing else.
        const closePattern = new RegExp(`^ {0,3}[${char}]{${String(fence.minLength)},}\\s*$`);
        if (closePattern.test(line)) {
          fence = null;
          closedFence = true;
        }
        isCode = true;
      } else {
        // A fence-like line of the other style inside a fence is content.
        isCode = true;
      }
    }

    // <pre> / <code> elements: crude open/close counting with indexOf (no regex
    // backtracking). Over-matching (e.g. `<preview>`) only masks more, never less.
    // Not counted inside a fenced code block: every line there is masked already, and a
    // literal "<pre>" in the sample text must not leak into the tag depth. A fence-closing
    // line still counts its tags — a <pre> after the closing fence is real.
    if (fence === null || closedFence) {
      const opens = countAny(lower, ['<pre', '<code']);
      const closes = countAny(lower, ['</pre', '</code']);
      if (opens > 0) {
        isCode = true;
      }
      tagDepth = Math.max(0, tagDepth + opens - closes);
    }

    return isCode ? line.replace(/[\s\S]/g, ' ') : line;
  });
  return masked.join('\n');
}

function countAny(haystack: string, needles: string[]): number {
  let count = 0;
  for (const needle of needles) {
    let index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
      count += 1;
      index += needle.length;
    }
  }
  return count;
}

/**
 * Splits a body into its preamble (text before the first marker, never addressable by anchor)
 * and its blocks. A fresh RegExp per call: a module-level /g/ regex would carry lastIndex
 * state across calls.
 *
 * Marker detection runs on the documentation-masked body so a literal `<!-- @block:… -->`
 * inside a fenced code block or <pre>/<code> element never becomes an addressable block.
 * Masking preserves every offset, so all slices below still use the original body.
 */
function parseSpaceBlocks(body: string): { preamble: string; blocks: ParsedSpaceBlock[] } {
  const visible = maskDocumentationRegions(body);
  const pattern = new RegExp(BLOCK_ANCHOR_PATTERN.source, 'g');
  const markers: { anchor: string; markerStart: number; contentStart: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(visible)) !== null) {
    const rawAnchor = match[1];
    if (rawAnchor === undefined) {
      continue;
    }
    markers.push({
      anchor: rawAnchor.trim(),
      markerStart: match.index,
      contentStart: match.index + match[0].length,
    });
  }
  const first = markers[0];
  const preamble = first === undefined ? body : body.slice(0, first.markerStart);
  const blocks = markers.map((marker, index) => {
    const next = markers[index + 1];
    return {
      anchor: marker.anchor,
      markerStart: marker.markerStart,
      contentStart: marker.contentStart,
      contentEnd: next === undefined ? body.length : next.markerStart,
    };
  });
  return { preamble, blocks };
}

/** Unique anchor names in first-seen order, for the "valid anchors" lists in loud failures. */
function uniqueBlockAnchors(blocks: ParsedSpaceBlock[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const block of blocks) {
    if (!seen.has(block.anchor)) {
      seen.add(block.anchor);
      unique.push(block.anchor);
    }
  }
  return unique;
}

/** 80-character compaction-recovery preview: whitespace-collapsed, ellipsis-truncated. */
function blockPreview(content: string): string {
  // Slice a window before collapsing: the preview is 80 chars, so running the whitespace
  // collapse over a whole 64KB auto-body block is pure waste on every list_blocks call.
  const window = content.length > 240 ? content.slice(0, 240) : content;
  const collapsed = window.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed;
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
      annotations: { readOnlyHint: true },
      handler: async () => this.read(() => this.list()),
    }),
    defineTool({
      name: GET_SPACE_TOOL_NAME,
      description:
        'Read one persistent space by id: its metadata (name, purpose, status, format, revision) plus the current aggregate_revision, with the full body included unless include_body is false. Call this before update_space to read the current body and revision. Pass revision to read a retained historical revision instead of the current one (for example to inspect what a bad update overwrote). Pass include_body: false when you already have the body from a recent get_space and only need the current revision: this avoids duplicating large HTML in the prompt. include_body: false is for metadata-only reads — do not combine it with revision when you want to inspect the historical body. Use list_spaces first if you do not already have the space id.',
      schema: GET_SPACE_INPUT_SCHEMA,
      annotations: { readOnlyHint: true },
      handler: async input => this.read(() => this.get(input)),
    }),
    defineTool({
      name: CREATE_SPACE_TOOL_NAME,
      description:
        "Create one persistent space: a named, structured page the host renders in the Spaces view and keeps until archived. Use this instead of a sandbox file whenever the user wants something durable to track or come back to; call list_spaces first to check a space for the same subject does not already exist. Set format to 'markdown' for a plain list or note, and 'html' whenever the space is meant to be looked at rather than skimmed as a list: a tracker, board, or dashboard. A markdown body is the whole content of the page (headings, lists, and tables are all fine). An html body is one complete document fragment; the host injects a designed base stylesheet ahead of it, so write semantic HTML against its classes (.page-header for the title block, section or .card for grouped content, .grid-2 / .grid-3 to lay cards side by side, table with <thead>/<tbody>, .badge / .badge-success / .badge-warning for status pills, <details> for collapsible detail) and add only a small page-specific <style> block of your own, images from https URLs or data URIs; no <script>, no external stylesheets, and no external fonts (the host strips all three). For a tracker, put one row per tracked item in a table (markdown table, or a styled <table> for html) with the columns the user cares about. Pass body as an array of lines (one line per element, table rows one per element, blank lines as empty-string elements); a single string with escaped newlines is unreliable to produce correctly. Delimit the independently-updated sections of the body with `<!-- @block:name -->` markers (valid in html and markdown; anchor names are case-sensitive, prefer short kebab-case): each marker starts a block whose content runs to the next marker or the end of the body, so later update_space block_edits can replace one section without resending the page. expected_aggregate_revision is optional; omit it and the host fills in the current value.",
      schema: CREATE_SPACE_INPUT_SCHEMA,
      handler: async input => this.write(() => this.create(input)),
    }),
    defineTool({
      name: UPDATE_SPACE_TOOL_NAME,
      description:
        'Update one persistent space. Provide exactly one of body, edits, or block_edits. ' +
        "For body (full replacement): replaces name, purpose, status, format, and body wholesale \u2014 name, purpose, and status are required (format defaults to 'markdown' if omitted). Call get_space first to read the current values if you are changing only one field, then resend the full current body with your changes folded in. " +
        'For edits (delta updates): a list of up to 50 search/replace pairs applied to the current body in order; use this for small changes to a large space to avoid resending the full HTML. name, purpose, status, and format are optional with edits \u2014 omit them to leave metadata unchanged, provide them to change specific fields. ' +
        'Each search is an exact, case-sensitive, whitespace-sensitive substring match against the current body (lines joined by a single newline character). Copy search text verbatim from the most recent get_space body \u2014 do not retype, reformat, or normalize it, and never compose search strings from memory or from a metadata-only read: use edits only when you have the current body from a recent get_space in this conversation. ' +
        'Each search replaces every occurrence in the body, so use long, unique search strings anchored with surrounding context \u2014 never a single common word like a status label. The result reports how many occurrences each edit replaced, so check the counts match what you intended; if they do not, call revert_space to undo. ' +
        'Edits apply sequentially, so a later edit\u2019s search sees the result of earlier edits: keep edits independent \u2014 a later edit\u2019s search must not match text produced by an earlier edit\u2019s replacement. If two changes interact, combine them into a single edit. ' +
        'If an edit\u2019s search is not found, the entire update fails and nothing is persisted. Do NOT retry the edits and do NOT recompute search text from another read: delta retries after a miss do not converge. Send the full updated body instead (get_space first if you no longer have the current body, then pass body, not edits). After DELTA_BREAKER_TRIP_AFTER_FAILURES consecutive failed delta updates on one space, delta updates lock for the session: further edits or block_edits are refused until a successful full-body update or revert_space unlocks them. ' +
        'For block_edits (anchor-addressed delta updates): a list of up to 50 {anchor, new_content} pairs \u2014 the reliable delta path. Each anchor names a <!-- @block:name --> marker in the current body; new_content replaces that block\u2019s content wholesale, so you generate the new content instead of reproducing old text and there is nothing to mis-copy. Pass an empty new_content to delete the block; new <!-- @block:\u2026 --> markers inside new_content split the block. Anchor names are case-sensitive; an unknown or duplicated anchor fails the whole update and the error lists the valid anchors. A <!-- @block:\u2026 --> marker inside a fenced code block (``` / ~~~) or a <pre>/<code> element is documentation text, not a block, and cannot be addressed. A space with no block markers has one implicit block named "auto-body" covering the whole body. The result reports each block\u2019s new content length so you can verify the write. ' +
        'As a safety net, an update that would shrink the body to less than a tenth of its current size is refused unless you pass confirm_shrink: true \u2014 a truncated or accidental write must never silently wipe a space. ' +
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
    defineTool({
      name: LIST_BLOCKS_TOOL_NAME,
      description:
        'List the addressable blocks of one persistent space without resending the body: each block\u2019s anchor name, an 80-character preview of its content, and how many times the anchor occurs. A space whose body has no <!-- @block:\u2026 --> markers reports a single "auto-body" block covering the whole body. Text before the first marker (the preamble) is not addressable by anchor; it is reported separately with its preview and length, and edited via a full-body update_space. A <!-- @block:\u2026 --> marker inside a fenced code block (``` / ~~~) or a <pre>/<code> element is documentation text, not a block, and is not listed. Call this after a context compaction \u2014 or before update_space block_edits \u2014 to recover the current anchors cheaply instead of re-reading the full body with get_space.',
      schema: LIST_BLOCKS_INPUT_SCHEMA,
      annotations: { readOnlyHint: true },
      handler: async input => this.read(() => this.listBlocks(input)),
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
    const blockEdits = input.block_edits;
    const isDelta = input.edits !== undefined || blockEdits !== undefined;
    // Refuse a locked delta BEFORE any store I/O: the burn loop this guards against would
    // otherwise keep paying an aggregate-revision resolve plus a full-body read per refusal.
    // The lock check needs only authority/session/space id, so no read is required first.
    if (isDelta) {
      this.throwIfDeltaLocked(input.space_id);
    }
    const [expected_aggregate_revision, current] = await Promise.all([
      resolveAggregateRevision(this.options.store, this.options.authority, input.expected_aggregate_revision),
      this.requireCurrentSpace(input.space_id),
    ]);
    // Delta updates (edits or block_edits): apply to the current body in order. This avoids
    // resending large HTML through the tool call. A missing search, a bad anchor, or a
    // delta-computed body over the size limit fails before anything is persisted, and feeds
    // the consecutive-failure breaker below.
    let body = input.body;
    let edit_replacements: number[] | undefined;
    let block_results: { anchor: string; new_length: number; deleted: boolean }[] | undefined;
    if (isDelta) {
      try {
        if (input.edits !== undefined) {
          const applied = this.applySearchEdits(input.space_id, current.body, input.edits);
          body = applied.body;
          edit_replacements = applied.edit_replacements;
        } else if (blockEdits !== undefined) {
          const applied = this.applyBlockEdits(input.space_id, current.body, blockEdits);
          body = applied.body;
          block_results = applied.results;
        }
      } catch (error) {
        if (
          error instanceof SpaceEditNotFoundError ||
          error instanceof SpaceBlockAnchorError ||
          error instanceof SpaceBodyTooLongError
        ) {
          this.recordDeltaFailure(input.space_id);
        }
        throw error;
      }
    }
    this.checkShrink(input.space_id, current, body ?? '', input.confirm_shrink);
    const mutation = await this.options.store.updateSpace({
      tenant_id: this.options.authority.tenantId,
      created_by: this.options.authority.userRef,
      space_id: input.space_id,
      // On the delta paths, omitted metadata means "unchanged": fall back to current values.
      // On the full-body path, format keeps its historical schema default ('markdown') when omitted.
      name: input.name ?? current.name,
      purpose: input.purpose ?? current.purpose,
      status: input.status ?? current.status,
      body: body ?? '',
      format: input.format ?? (isDelta ? current.format : 'markdown'),
      expected_revision: input.expected_revision ?? current.revision,
      expected_aggregate_revision,
    });
    const outcome: WriteOutcome = { mutation };
    if (edit_replacements !== undefined) {
      outcome.edit_replacements = edit_replacements;
    }
    if (block_results !== undefined) {
      outcome.block_results = block_results;
    }
    // Reset only after the durable write succeeds. Resetting earlier (e.g. right after the
    // local delta application) would clear the counter even when shrink validation or the
    // store write then fails — unlocking a loop that never actually converged. A delta
    // success proves the model's mental copy converged; a full-body success proves it holds
    // the real body. (revert() resets on its own path after its own successful write.)
    this.resetDeltaBreaker(input.space_id);
    return outcome;
  }

  /**
   * Applies search/replace edits to a body in order. Extracted from update() unchanged: a
   * missing search fails before anything is persisted.
   */
  private applySearchEdits(
    space_id: string,
    currentBody: string,
    edits: { search: string; replace: string }[],
  ): { body: string; edit_replacements: number[] } {
    let edited = currentBody;
    const edit_replacements: number[] = [];
    for (const [index, edit] of edits.entries()) {
      const parts: string[] = edited.split(edit.search);
      if (parts.length < 2) {
        throw new SpaceEditNotFoundError({ search: edit.search, index });
      }
      edit_replacements.push(parts.length - 1);
      // Check the resulting length arithmetically BEFORE joining: a huge
      // replace string could otherwise OOM the process building the joined
      // string before the length check ever runs. Exact under the
      // <= SPACE_BODY_MAX_LENGTH invariant every writer enforces.
      const new_length = edited.length + (parts.length - 1) * (edit.replace.length - edit.search.length);
      if (new_length > SPACE_BODY_MAX_LENGTH) {
        throw new SpaceBodyTooLongError({ space_id, new_length });
      }
      edited = parts.join(edit.replace);
    }
    return { body: edited, edit_replacements };
  }

  /**
   * Applies anchor-addressed edits to a body in order, re-parsing block structure after each
   * edit so a later edit sees earlier results (including anchors introduced by new_content).
   * Unknown or duplicated anchors fail closed before anything is persisted; the error lists
   * the valid anchors.
   */
  private applyBlockEdits(
    space_id: string,
    currentBody: string,
    edits: { anchor: string; new_content: string }[],
  ): { body: string; results: { anchor: string; new_length: number; deleted: boolean }[] } {
    let body = currentBody;
    const results: { anchor: string; new_length: number; deleted: boolean }[] = [];
    for (const [index, edit] of edits.entries()) {
      const anchor = edit.anchor.trim();
      const { blocks } = parseSpaceBlocks(body);
      let newBody: string;
      let resultLength: number;
      let deleted: boolean;
      if (blocks.length === 0) {
        // Anchorless space: only the implicit whole-body block is addressable.
        if (anchor !== AUTO_BLOCK_ANCHOR) {
          throw new SpaceBlockAnchorNotFoundError({
            space_id,
            anchor,
            index,
            validAnchors: [AUTO_BLOCK_ANCHOR],
          });
        }
        if (edit.new_content.length > SPACE_BODY_MAX_LENGTH) {
          throw new SpaceBodyTooLongError({ space_id, new_length: edit.new_content.length });
        }
        newBody = edit.new_content;
        resultLength = edit.new_content.length;
        deleted = false;
      } else {
        const matches = blocks.filter(block => block.anchor === anchor);
        const target = matches[0];
        if (target === undefined) {
          throw new SpaceBlockAnchorNotFoundError({
            space_id,
            anchor,
            index,
            validAnchors: uniqueBlockAnchors(blocks),
          });
        }
        if (matches.length > 1) {
          throw new SpaceBlockAnchorDuplicateError({
            space_id,
            anchor,
            index,
            occurrences: matches.length,
            validAnchors: uniqueBlockAnchors(blocks),
          });
        }
        if (edit.new_content === '') {
          // Delete the block: marker and content both go.
          const new_length = body.length - (target.contentEnd - target.markerStart);
          if (new_length > SPACE_BODY_MAX_LENGTH) {
            throw new SpaceBodyTooLongError({ space_id, new_length });
          }
          newBody = body.slice(0, target.markerStart) + body.slice(target.contentEnd);
          resultLength = 0;
          deleted = true;
        } else {
          // Arithmetic length check before materializing, mirroring the edits path.
          const new_length = body.length - (target.contentEnd - target.contentStart) + edit.new_content.length;
          if (new_length > SPACE_BODY_MAX_LENGTH) {
            throw new SpaceBodyTooLongError({ space_id, new_length });
          }
          // Keep the marker on its own line: a line break immediately after the marker is
          // layout, not content, so preserve it instead of gluing new_content to `-->`.
          let separator = '';
          if (body.startsWith('\r\n', target.contentStart)) {
            separator = '\r\n';
          } else if (body.charAt(target.contentStart) === '\n') {
            separator = '\n';
          }
          newBody = body.slice(0, target.contentStart) + separator + edit.new_content + body.slice(target.contentEnd);
          // The preserved separator is part of the stored block content.
          resultLength = separator.length + edit.new_content.length;
          deleted = false;
        }
      }
      body = newBody;
      results.push({ anchor, new_length: resultLength, deleted });
    }
    return { body, results };
  }

  /**
   * Cheap compaction-recovery read: the space's block anchors with an 80-character preview of
   * each block's content and the anchor's occurrence count — everything block_edits needs,
   * without resending the body. A space with no markers reports the single implicit
   * AUTO_BLOCK_ANCHOR block. Text before the first marker (the preamble) is not
   * addressable by anchor, so it is surfaced separately with its preview and length.
   */
  private async listBlocks(input: z.infer<typeof LIST_BLOCKS_INPUT_SCHEMA>): Promise<ListBlocksResult> {
    const current = await this.requireCurrentSpace(input.space_id);
    const { preamble, blocks } = parseSpaceBlocks(current.body);
    const preambleInfo =
      blocks.length > 0 && preamble.length > 0
        ? { preview: blockPreview(preamble), char_count: preamble.length }
        : null;
    if (blocks.length === 0) {
      return {
        space_id: input.space_id,
        revision: current.revision,
        preamble: preambleInfo,
        blocks: [{ anchor: AUTO_BLOCK_ANCHOR, preview: blockPreview(current.body), occurrences: 1 }],
      };
    }
    const byAnchor = new Map<string, { preview: string; occurrences: number }>();
    for (const block of blocks) {
      const content = current.body.slice(block.contentStart, block.contentEnd);
      const existing = byAnchor.get(block.anchor);
      if (existing === undefined) {
        byAnchor.set(block.anchor, { preview: blockPreview(content), occurrences: 1 });
      } else {
        existing.occurrences += 1;
      }
    }
    return {
      space_id: input.space_id,
      revision: current.revision,
      preamble: preambleInfo,
      blocks: [...byAnchor.entries()].map(([anchor, info]) => ({ anchor, ...info })),
    };
  }

  /** Breaker scope: the configured session id, or a per-instance key when none was provided. */
  private readonly deltaBreakerInstanceId = ++deltaBreakerInstanceCounter;

  private deltaBreakerKey(space_id: string): string {
    const sessionKey = this.options.sessionId ?? `#instance-${String(this.deltaBreakerInstanceId)}`;
    return deltaBreakerKey({ authority: this.options.authority, sessionKey, spaceId: space_id });
  }

  private throwIfDeltaLocked(space_id: string): void {
    if (deltaBreaker.get(this.deltaBreakerKey(space_id))?.locked === true) {
      throw new SpaceDeltaLockedError({ space_id });
    }
  }

  /**
   * Records one failed delta update (missed search, bad anchor, or delta-computed body over
   * the size limit). At the trip threshold the space's delta mode locks. Every failure is
   * logged: the next burn loop must be visible at failure #2, not discovered at #8.
   */
  private recordDeltaFailure(space_id: string): void {
    const key = this.deltaBreakerKey(space_id);
    const entry = deltaBreaker.get(key) ?? { failures: 0, locked: false };
    entry.failures += 1;
    if (entry.failures >= DELTA_BREAKER_TRIP_AFTER_FAILURES) {
      entry.locked = true;
    }
    deltaBreaker.set(key, entry);
    if (deltaBreaker.size > DELTA_BREAKER_MAX_ENTRIES) {
      // Evict the oldest entry of THIS tenant first: one tenant churning through spaces
      // must not silently clear another tenant's failure counter (or worse, its lock).
      // Only when this tenant holds no entries at all do we fall back to the global oldest.
      const tenantPrefix = `${this.options.authority.tenantId}${BREAKER_KEY_SEPARATOR}`;
      let victim: string | undefined;
      for (const candidate of deltaBreaker.keys()) {
        if (candidate.startsWith(tenantPrefix)) {
          victim = candidate;
          break;
        }
      }
      if (victim === undefined) {
        const oldest = deltaBreaker.keys().next();
        if (!oldest.done) {
          victim = oldest.value;
        }
      }
      if (victim !== undefined) {
        deltaBreaker.delete(victim);
      }
    }
    this.options.logger?.warn('space delta edit failed', {
      space_id,
      session_id: this.options.sessionId,
      consecutive_failures: entry.failures,
      delta_locked: entry.locked,
    });
  }

  /** Any success — a delta write, a full-body write, or a revert — resets the breaker. */
  private resetDeltaBreaker(space_id: string): void {
    deltaBreaker.delete(this.deltaBreakerKey(space_id));
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
    // A successful revert unlocks delta mode: the space is back at a known-good revision.
    this.resetDeltaBreaker(input.space_id);
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
      | ListBlocksResult
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
      | { space: SpaceRecord; aggregate_revision: number; include_body: boolean }
      | ListBlocksResult,
  ) {
    if ('spaces' in result) {
      return {
        spaces: result.spaces.map(record => SPACE_SUMMARY_SCHEMA.parse(record)),
        aggregate_revision: result.aggregate_revision,
        has_more: result.has_more,
      };
    }
    if ('blocks' in result) {
      return result;
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
   * over the size limit, a delta edit whose search text is not found, a bad block anchor, or a
   * locked delta mode, all with a stable sanitized message) becomes a terminal tool error here.
   * Any other exception is an unexpected infrastructure or programming failure and is rethrown
   * uncaught so its exception and stack reach the tracing wrapper instead of being collapsed
   * into an ordinary nonzero tool result.
   */
  private async write(run: () => Promise<WriteOutcome>) {
    try {
      const { mutation, ...annotations } = await run();
      return toolResultResponse({ text: mutationResultText(mutation, annotations) });
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
      if (error instanceof SpaceBlockAnchorError) {
        return toolResultResponse({ text: JSON.stringify({ error: error.message }), isError: true });
      }
      if (error instanceof SpaceDeltaLockedError) {
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
    const isRead =
      params.name === LIST_SPACES_TOOL_NAME ||
      params.name === GET_SPACE_TOOL_NAME ||
      params.name === LIST_BLOCKS_TOOL_NAME;
    return {
      ...info,
      effect: isRead ? 'inspect' : 'edit',
      read_only_hint: isRead,
      destructive_hint: false,
      open_world_hint: false,
    };
  }
}

/** Attaches `list_spaces` / `get_space` / `create_space` / `update_space` / `revert_space` / `list_blocks` to one turn's root thread. */
export function spaceCapability(options: SpaceCapabilityOptions): AgentCapability {
  return {
    systemToolSets: [new SpaceTool(options)],
    instructionBuilders: [buildSpaceInstruction],
  };
}

export interface SpaceTurnContext {
  store: SpaceToolStore;
  /** Per-user Google logins; absent, no Gmail tools mount. */
  googleConnections?: GoogleConnectionStore | undefined;
  authority: SpaceTurnAuthority;
  /** Chat session id: keys the delta-failure breaker per session (see SpaceCapabilityOptions). */
  sessionId: string;
  /** Operational log for delta-edit failures. */
  logger: Logger;
}

/**
 * Adds the space tools after memory resolution, the same root-thread-only gate the memory and
 * tool-output-screen capabilities use: a child agent's thread is not what the user opens the
 * Spaces view to see, so it gets no space tools of its own.
 */
export class SpaceTurnResourceResolver extends MemoryTurnResourceResolver {
  constructor(
    ...args: [
      ...ConstructorParameters<typeof MemoryTurnResourceResolver>,
      space: SpaceTurnContext,
      toolImages: ToolImagesOptions,
    ]
  ) {
    const [
      deps,
      profile,
      persona,
      memory,
      toolOutputScreen,
      personaKnowledgeBlock,
      personaKnowledgeHits,
      switchNotice,
      space,
      toolImages,
    ] = args;
    super(deps, profile, persona, memory, toolOutputScreen, personaKnowledgeBlock, personaKnowledgeHits, switchNotice);
    this.#space = space;
    this.#toolImages = toolImages;
  }

  readonly #space: SpaceTurnContext;
  readonly #toolImages: ToolImagesOptions;
  /** The run's sandbox, resolved before any thread is built; mail attachments are placed in it. */
  private runSandbox: Sandbox | undefined;

  override async resolveSandbox(input: Parameters<MemoryTurnResourceResolver['resolveSandbox']>[0]) {
    this.runSandbox = await super.resolveSandbox(input);
    return this.runSandbox;
  }

  override async resolveAgentDefinition(input: Parameters<MemoryTurnResourceResolver['resolveAgentDefinition']>[0]) {
    const resolved = await super.resolveAgentDefinition(input);
    const isSubAgent = input.agent_info !== undefined;
    if (isSubAgent) {
      return resolved;
    }
    const gmail = await this.#gmail(input);
    return {
      ...resolved,
      extraCapabilities: [
        ...(resolved.extraCapabilities ?? []),
        spaceCapability({ ...this.#space, tracing: input.tracing }),
        mapsCapability({ tracing: input.tracing, logger: this.#space.logger }),
        toolImagesCapability(this.#toolImages),
        ...(gmail === undefined ? [] : [gmail]),
      ],
    };
  }

  /** A store that cannot be read costs the chat its mail tools, never the chat itself. */
  async #gmail(input: Parameters<MemoryTurnResourceResolver['resolveAgentDefinition']>[0]) {
    const connections = this.#space.googleConnections;
    if (connections === undefined) {
      return undefined;
    }
    try {
      return await gmailCapability({
        fetchImpl: undefined,
        connections,
        owner: { tenant_id: input.tenant_id, created_by: input.created_by },
        tracing: input.tracing,
        sentinel: createSentinelHostContext({
          services: input.sentinel_services,
          tenant_id: input.tenant_id,
          created_by: input.created_by,
          conversation_id: input.session_id,
          workspace_cwd: input.workspace_cwd ?? null,
          web_search: this.webSearchTurn,
        }),
        attachmentStager: sandboxAttachmentStager(this.runSandbox),
      });
    } catch (error) {
      this.#space.logger.warn(
        'Gmail tools not mounted: the Google login could not be read',
        extractErrorLogFields(error),
      );
      return undefined;
    }
  }
}
