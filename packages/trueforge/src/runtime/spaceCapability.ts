/**
 * A space is a persistent, named, structured page the model creates through
 * `create_space`, changes through `edit_space`, reads through `list_spaces` / `get_space`
 * (which can also read a retained historical revision), restores through `revert_space`, and
 * the UI renders (see `packages/frontend/src/spaceStore.ts`). Unlike a sandbox file, a space
 * survives the turn and session that created it and is visible in the Spaces view without the
 * user opening the chat that produced it.
 *
 * There is no `delete_space` tool, deliberately: the model must not be able to remove a page the
 * user is keeping. Deleting a space is a UI-only action (`DELETE /api/v1/spaces/{space_id}`,
 * exposed from the space's own page), never something a running turn can reach.
 */
import type {
  AgentCapability,
  AgentTracing,
  InstructionBuilder,
  Sandbox,
  WebSearchTurnState,
} from '@truefoundry/trueforge-core/core';
import {
  createSentinelHostContext,
  defineTool,
  extractErrorLogFields,
  LocalToolMCP,
  toolResultResponse,
  type ToolDefinition,
} from '@truefoundry/trueforge-core/core';
import type { GoogleConnectionStore } from '@truefoundry/trueforge-core/core/google/connection';
import type { ToolBundleName } from '@truefoundry/trueforge-core/core/runtime/toolBundleCatalog';
import {
  CREATE_SPACE_TOOL_NAME,
  EDIT_SPACE_TOOL_NAME,
  GET_SPACE_TOOL_NAME,
  LIST_BLOCKS_TOOL_NAME,
  LIST_SPACES_TOOL_NAME,
  REVERT_SPACE_TOOL_NAME,
  SPACE_SERVER_ID,
  SPACE_WRITE_TOO_LONG_ERROR_CODE,
} from '@truefoundry/trueforge-core/core/spaces/toolContract';
import { ulid } from 'ulid';
import type { Logger } from 'winston';
import { z } from 'zod';
import configuration from '../config';
import {
  SpaceAggregateRevisionConflictError,
  SpaceNotFoundError,
  SpaceRevisionConflictError,
  SpaceRevisionNotFoundError,
  type ISpaceStore,
  type SpaceMutationResult,
  type SpaceRecord,
} from '../db/spaceStore';
import { evalSources } from '../eval/fixtures';
import {
  SPACE_BODY_MAX_LENGTH,
  SPACE_LIST_LIMIT,
  SPACE_WRITE_MAX_LENGTH,
  SpaceContentSchema,
  SpaceFormatSchema,
  SpaceSchema,
  SpaceStatusSchema,
} from '../schemas/space';
import { toolImagesCapability, type ToolImagesOptions } from './chatImages/toolImagesCapability';
import { googleCapability, sandboxAttachmentStager } from './googleCapability';
import { googleSetupCapability } from './googleSetupCapability';
import { mapsCapability } from './mapsCapability';
import { MemoryTurnResourceResolver } from './MemoryTurnResourceResolver';
import { personaCapability, type PersonaTurnContext } from './personaCapability';
import { scheduleCapability, type ScheduleTurnContext } from './scheduleCapability';
import { refuseNewSpaceLinks, SpaceLinkRefusedError } from './spaceLinks';
import { usageSummaryCapability, type UsageSummaryTurnContext } from './usageSummaryCapability';

/**
 * Server-assigned anchor for the implicit whole-body block of a space that declares no
 * `<!-- @block:… -->` markers. The id is a constant, so it is stable by construction: the same
 * across turns, compactions, and revisions, with nothing to persist. An `edit_space` block edit
 * against it replaces (or, with empty new_content, deletes) the entire body, subject to the usual
 * shrink guard.
 */
export const AUTO_BLOCK_ANCHOR = 'auto-body';

/**
 * Thrown when a delta edit's search text is not found in the current body. The error message is
 * self-contained: it states that nothing was persisted, shows the search text, and steers away
 * from delta retries — a miss means the model's mental copy of the body diverged, and recomputed
 * search text does not converge. The recovery is to re-read the space and re-apply the change
 * in parts from the fresh read, which works at any body size.
 */
export class SpaceEditNotFoundError extends Error {
  readonly search: string;
  readonly index: number;

  constructor(input: { search: string; index: number }) {
    const preview = input.search.length > 500 ? `${input.search.slice(0, 500)}…` : input.search;
    super(
      `Edit #${String(input.index + 1)} search text not found in the space's current body. ` +
        `Nothing was persisted: the space is unchanged. ` +
        `Search text (exact, case- and whitespace-sensitive): "${preview}". ` +
        `Do not retry this search and do not recompute search text from memory: delta retries ` +
        `after a miss do not converge. Re-read the space with get_space first (list_blocks names ` +
        `its sections), then make the change with edit_space in parts: a block edit naming one of ` +
        `its anchors, or a corrected search copied from the fresh read.`,
    );
    this.name = 'SpaceEditNotFoundError';
    this.search = input.search;
    this.index = input.index;
  }
}

/**
 * Base class for block-anchor addressing failures on the edit_space path. Like
 * SpaceEditNotFoundError, these are terminal tool errors: nothing is persisted, and the message
 * lists the valid anchors so the model can address a real block (or re-read the space and use
 * search edits) instead of guessing.
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
        `in edit_space entry #${String(input.index + 1)} for space "${input.space_id}". ` +
        `Nothing was persisted: the space is unchanged. ` +
        `Valid anchors: ${input.validAnchors.map(a => `"${a}"`).join(', ')}. ` +
        `Retry edit_space with one of the valid anchors. If the change is not inside one block, ` +
        `re-read the space with get_space and make it with a search edit copied from the fresh read.`,
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
 * fails closed instead. The model renames all but one of the duplicates with search edits
 * whose search text includes the text right after the marker, so each rename touches only
 * the one copy it means to.
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
      `space "${input.space_id}" (edit_space entry #${String(input.index + 1)}): edit_space needs ` +
      `a unique anchor, so nothing was persisted: the space is unchanged. ` +
      `Rename all but one of the duplicates, then retry edit_space. To rename one copy, re-read ` +
      `the space with get_space, then send a search edit whose search text is the marker plus the ` +
      `text right after it (so it matches only that one copy) and whose replacement is the marker ` +
      `with a new name plus that same text. ` +
      `Currently unique anchors: ${uniqueList}.`;
  }
}

/**
 * Thrown when edit_space is called on a space whose delta mode the server locked after
 * consecutive failed delta updates. Terminal for edit_space until a revert unlocks it:
 * restoring the space's current revision with revert_space unlocks it without changing
 * the body at all, which is the recovery that works for a body of any size.
 */
export class SpaceDeltaLockedError extends Error {
  readonly space_id: string;

  constructor(input: { space_id: string }) {
    super(
      `Delta updates for space "${input.space_id}" are locked after consecutive failed delta ` +
        `updates in this session. Nothing was persisted: the space is unchanged. ` +
        `Do not call edit_space again for this space. ` +
        `To unlock it without losing any content, call revert_space with the space's current ` +
        `revision (get_space shows it): restoring the current revision keeps the body exactly ` +
        `as it is and clears the lock. Then re-read the space and make the change with ` +
        `edit_space in parts.`,
    );
    this.name = 'SpaceDeltaLockedError';
    this.space_id = input.space_id;
  }
}

/**
 * Thrown when an edit_space call computes a body longer than the schema's
 * character limit. A tool-layer policy, not a store error: it never reaches the database.
 * Exported alongside SpaceEditNotFoundError: both are terminal tool errors surfaced by write().
 */
export class SpaceBodyTooLongError extends Error {
  readonly space_id: string;
  readonly new_length: number;

  constructor(input: { space_id: string; new_length: number }) {
    super(
      `Refusing edit_space on "${input.space_id}": the new body (${input.new_length.toLocaleString('en-US')} characters) ` +
        `exceeds the ${SPACE_BODY_MAX_LENGTH.toLocaleString('en-US')}-character limit. Nothing was persisted — the space is unchanged. ` +
        `Shorten the resulting body: use smaller replacements, or remove content with additional edits.`,
    );
    this.name = 'SpaceBodyTooLongError';
    this.space_id = input.space_id;
    this.new_length = input.new_length;
  }
}

/**
 * Thrown when an edit_space call would leave a space with an empty body. A space body is
 * never empty (the same refusal create_space's schema gives), so a wipe to nothing is
 * refused here with the same words instead of persisting an empty space.
 */
export class SpaceBodyEmptyError extends Error {
  readonly space_id: string;

  constructor(input: { space_id: string }) {
    super('The space body is empty. Send the page content again.');
    this.name = 'SpaceBodyEmptyError';
    this.space_id = input.space_id;
  }
}

/**
 * Thrown when one write call carries more new content than SPACE_WRITE_MAX_LENGTH. A
 * tool-layer policy, not a store error: it never reaches the database. It exists because
 * models stall while writing very long tool arguments, so a space is built in parts: the
 * refusal names the limit and the next step, and nothing is persisted.
 */
export class SpaceWriteTooLongError extends Error {
  readonly tool: string;
  readonly new_length: number;

  constructor(input: { tool: string; space_id: string | null; new_length: number }) {
    const subject = input.space_id === null ? input.tool : `${input.tool} on "${input.space_id}"`;
    const next =
      input.tool === CREATE_SPACE_TOOL_NAME
        ? 'Send a shorter body now (a heading and the first part), then add the rest with edit_space once the space exists.'
        : 'Send the first part now, then send the rest in a follow-up edit_space call.';
    super(
      `Refusing ${subject}: this write carries ${input.new_length.toLocaleString('en-US')} characters of new content, ` +
        `and one write may carry at most ${SPACE_WRITE_MAX_LENGTH.toLocaleString('en-US')}. Nothing was persisted. ${next}`,
    );
    this.name = 'SpaceWriteTooLongError';
    this.tool = input.tool;
    this.new_length = input.new_length;
  }
}

/**
 * Streamed-argument limits for the space write tools. The stream counts the call's JSON
 * arguments as they arrive, so a limit must clear the largest call the tool layer would
 * accept, measured in streamed characters, or the stream cut refuses a call that is
 * valid. The derivation, field by field from the input schemas:
 *
 * A character inside a JSON string can stream as a six-character escape (a control
 * character written as a unicode escape), so every string field counts at six times its
 * source length. Key names, punctuation, numbers, and true-or-false values never escape; they
 * get one flat allowance per call.
 *
 * create_space carries one body (at most SPACE_WRITE_MAX_LENGTH of new
 * content by the write cap), a purpose (at most 2,000), a name (at most 160), a status
 * and a format (at most 8 each), plus one short field of headroom: 6 * (4,000 + 2,000 +
 * 160 + 160 + 8 + 8) + 2,000 of framing = 40,016.
 *
 * edit_space carries up to 50 entries. An entry's search text is copied from the stored
 * body, so one search can be as long as a whole body (SPACE_BODY_MAX_LENGTH) and 50 of
 * them dominate the call: 50 * 65,536. Anchors are at most 200 each (50 * 200, counted
 * too even though an entry carries a search or an anchor, never both). The new content
 * (every entry's replace and new_content together) is capped at SPACE_WRITE_MAX_LENGTH.
 * The metadata fields match create: 2,000 + 160 + 160 + 8 + 8. Total:
 * 6 * (50 * 65,536 + 50 * 200 + 4,000 + 2,000 + 160 + 160 + 8 + 8) + 3,000 of framing
 * = 19,761,816.
 *
 * The edit_space limit is therefore large: a search that copies a stored page is
 * legitimate, however long it streams. What stops a runaway edit_space call in practice
 * is the tool-call idle allowance (a call that goes silent mid-write is stopped on
 * time, not on size); this limit is only the backstop for a call that keeps streaming
 * past every valid shape.
 */
const STREAMED_JSON_ESCAPE_FACTOR = 6;
const CREATE_STREAMED_ARGUMENT_LIMIT =
  STREAMED_JSON_ESCAPE_FACTOR * (SPACE_WRITE_MAX_LENGTH + 2_000 + 160 + 160 + 8 + 8) + 2_000;
const EDIT_STREAMED_ARGUMENT_LIMIT =
  STREAMED_JSON_ESCAPE_FACTOR *
    (50 * SPACE_BODY_MAX_LENGTH + 50 * 200 + SPACE_WRITE_MAX_LENGTH + 2_000 + 160 + 160 + 8 + 8) +
  3_000;
export const SPACE_WRITE_TOOL_ARGUMENT_LIMITS: ReadonlyMap<string, number> = new Map([
  [CREATE_SPACE_TOOL_NAME, CREATE_STREAMED_ARGUMENT_LIMIT],
  [EDIT_SPACE_TOOL_NAME, EDIT_STREAMED_ARGUMENT_LIMIT],
]);

/**
 * A `space_name` lookup that cannot pick one space: no match, several matches, or too many
 * spaces to be sure. Terminal tool error; the message says the one next step.
 */
class SpaceNameLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpaceNameLookupError';
  }
}

/** Consecutive failed delta updates on one space before delta mode locks; the model is told this number. */
const DELTA_BREAKER_TRIP_AFTER_FAILURES = 3;

const SPACE_INSTRUCTION_SECTION = 'spaces';
const SPACE_INSTRUCTION = `
When the user asks you to build, create, or keep up a space (a tracker, board, or page they want updated), call list_spaces first. If one already covers the subject, update it; create a new one only when none fits. A space has a name, a purpose, a status (active or archived), a format (markdown or html), and a body. The host shows it in the Spaces view, not as a file.

Build a large space in steps, not in one call: one write carries at most about 4,000 characters of new content, and a write past that is refused with nothing saved. For a space with sections, first create a short skeleton: a title and one section per part, each opened by a marker such as <!-- @block:pricing -->. The create result gives the space's name and link, not an id: use that exact name later (space_name). Then fill one block per edit_space call, addressed by the marker's name, with new_content as the block's complete new content. For a long table or list with no sections, create the space with the heading and the first rows, then add the rest a few rows at a time with edit_space search edits that extend the last row, so the person sees it fill in as it goes. To read a space's current body, call get_space with space_name. After a context compaction, call list_blocks to recover the anchors. When you mention a space to the person, link its name to its link; never show an id. A space is always addressed by its exact name, and names are unique: create_space refuses a name an existing space already has, so pick a different name or change the existing space instead. If a create_space or edit_space call fails because its arguments did not finish, do not send the same call again: send the content in smaller parts with edit_space.

Pass body as one string with real line breaks: each table row on its own line, and a blank line as an empty line. For a list or a note, use format 'markdown'. Use format 'html' when layout, colour, or structure carries meaning, such as a tracker, board, or dashboard. An html space is one complete document fragment: no <script>, no external stylesheets, and no external fonts. The host injects a base stylesheet ahead of it: a type scale, a warm neutral palette with one accent, and a 4px spacing rhythm. Use its classes rather than writing page chrome: .page-header (a title plus a .subtitle), section or .card, .grid-2 or .grid-3, table with <thead> and <tbody>, .badge with .badge-success or .badge-warning, and <details>. Add a small <style> block only for page-specific touches. Example: \`<div class="page-header"><h1>Spain house search</h1><p class="subtitle">6 candidates</p></div><div class="grid-2"><div class="card"><h3>Budget</h3><p>€450,000</p></div></div><table><thead><tr><th>Address</th><th>Status</th></tr></thead><tbody><tr><td>Calle Mayor 1</td><td><span class="badge badge-success">Viewed</span></td></tr></tbody></table>\`.

If the web-artifacts-builder skill is mounted, follow its SKILL.md design guidance, but do not run its bundling scripts: a space is an HTML fragment the host renders, not a bundled app. Author every html space on those classes, as one self-contained document with inline CSS. The host's sanitiser decides what actually renders.

Pictures: use only picture links that a search or page result in this chat returned, never one you made up; search for a picture first if you need one. The host refuses any other link.

For a tracker (houses, tasks, candidates, or anything with several items), put one row per item in a table, with columns for what the user cares about.

There is no whole-body replacement tool: every change to an existing space goes through edit_space, which changes part of a body without resending it: each entry in edits is a search/replace pair (type 'search') or an anchor-addressed block replacement (type 'block'). edit_space can also change the space's purpose, status, or format, and rename it: pass new_title for the new name. Use block edits for one section, search edits for a small change to a space with no markers: each search is an exact, case-sensitive substring copied verbatim from the latest get_space. A search that does not match fails the whole edit, so do not retry it: re-read the space and correct the search from the fresh read, or address the change to one of its blocks. An unknown or duplicate anchor also fails the edit, and the error lists the valid anchors. A space with no markers has one block, "auto-body", covering the whole body. A marker inside a fenced code block or a <pre> or <code> element is text, not a block. After ${String(DELTA_BREAKER_TRIP_AFTER_FAILURES)} consecutive failed edit_space calls on one space, edit_space is refused until it is unlocked: revert_space with the space's current revision unlocks it without changing the body. Every change keeps the previous revision: to undo a bad change, call revert_space rather than rebuilding the content from memory. expected_revision and expected_aggregate_revision are optional: leave them out; if one is stale, the error names the current value, so retry once with it.
`;

function buildSpaceInstruction(builder: InstructionBuilder): void {
  builder.addSection(SPACE_INSTRUCTION_SECTION, SPACE_INSTRUCTION);
}

/**
 * A space body is one string with real line breaks. The old array-of-lines form is gone from
 * the contract entirely: a caller that sends lines as an array gets a validation error, not a
 * silently joined body it never checked. Nothing past this point ever sees the array form,
 * and the store already persisted bodies as single strings, so no stored shape changes.
 */
const SPACE_BODY_INPUT_SCHEMA = SpaceContentSchema.shape.body.refine(value => value.trim().length > 0, {
  message: 'The space body is empty. Send the page content again.',
});

/**
 * One plain line naming each bad field of a space call, so the model gets the exact field error
 * instead of a bare "Validation failed". Zod's jargon is translated where it is short; a refine
 * message, already written in plain words, passes through unchanged. Every error ends with the
 * one thing to do next, so a refused call is always actionable.
 */
function spaceInvalidInput(error: z.ZodError): string {
  const plain = (message: string): string => {
    if (message === 'Required') {
      return 'is missing';
    }
    if (message.includes('must contain at least') || message.startsWith('Too small:')) {
      return 'is too short';
    }
    if (message.includes('must contain at most') || message.startsWith('Too big:')) {
      return 'is too long';
    }
    return message;
  };
  const parts = error.issues.map(issue => {
    const field = issue.path.map(part => String(part)).join('.');
    const message = plain(issue.message);
    return field === '' ? message : `${field}: ${message}`;
  });
  const base = parts.length === 0 ? 'Invalid space call.' : `Invalid space call: ${parts.join('; ')}.`;
  return JSON.stringify({
    error: `${base} Fix the listed fields and send the call again.`,
  });
}

const LIST_SPACES_INPUT_SCHEMA = z.object({}).strict();
/**
 * A space is addressed by its exact name, only. There is no id field on any space tool:
 * the model never sees an id, so it can never send one, and a name always picks the space.
 */
const SPACE_NAME_FIELD = z.string().trim().min(1).max(160);
const GET_SPACE_INPUT_SCHEMA = z
  .object({
    space_name: SPACE_NAME_FIELD,
    revision: z.number().int().positive().optional(),
    include_body: z.boolean().default(true),
  })
  .strict();
const CREATE_SPACE_INPUT_SCHEMA = SpaceContentSchema.extend({
  body: SPACE_BODY_INPUT_SCHEMA,
  expected_aggregate_revision: z.number().int().nonnegative().optional(),
}).strict();
/** One search/replace entry of an edit_space call: `search` must match exactly, every occurrence is replaced. */
const SPACE_SEARCH_EDIT_SCHEMA = z
  .object({
    type: z.literal('search'),
    search: z.string().min(1),
    replace: z.string(),
  })
  .strict();
/**
 * One anchor-addressed entry of an edit_space call: `anchor` names a `<!-- @block:name -->`
 * marker in the current body (or "auto-body" for a space with no markers) and `new_content`
 * replaces that block's content wholesale. Empty `new_content` deletes the block.
 */
const SPACE_BLOCK_EDIT_SCHEMA = z
  .object({
    type: z.literal('block'),
    // Anchors are short kebab-case names by convention; the max bounds how much
    // model-controlled text can flow into error messages.
    anchor: z.string().min(1).max(200),
    new_content: z.string(),
  })
  .strict();
/** The one edit list shape: every entry names its own kind, so search and block edits never mix ambiguously. */
const SPACE_DELTA_EDIT_SCHEMA = z.discriminatedUnion('type', [SPACE_SEARCH_EDIT_SCHEMA, SPACE_BLOCK_EDIT_SCHEMA]);
/**
 * On the edit path, new_title/purpose/status/format are optional: omit them to leave the
 * metadata unchanged, provide them to change specific fields. The edits list itself is
 * required: an edit call with nothing to change is a wasted step, not a metadata-only update.
 * The rename field is new_title, never name: name is create_space's title field, and keeping
 * the two apart means a call can never confuse which space it means with what to call it.
 */
const EDIT_SPACE_INPUT_SCHEMA = z
  .object({
    space_name: SPACE_NAME_FIELD,
    new_title: z.string().trim().min(1).max(160).optional(),
    purpose: z.string().trim().min(1).max(2_000).optional(),
    status: SpaceStatusSchema.optional(),
    format: SpaceFormatSchema.optional(),
    edits: z.array(SPACE_DELTA_EDIT_SCHEMA).min(1).max(50),
    expected_revision: z.number().int().positive().optional(),
    expected_aggregate_revision: z.number().int().nonnegative().optional(),
    confirm_shrink: z.boolean().optional(),
  })
  .strict();
const REVERT_SPACE_INPUT_SCHEMA = z
  .object({
    space_name: SPACE_NAME_FIELD,
    revision: z.number().int().positive(),
    expected_revision: z.number().int().positive().optional(),
    expected_aggregate_revision: z.number().int().nonnegative().optional(),
  })
  .strict();
const LIST_BLOCKS_INPUT_SCHEMA = z
  .object({
    space_name: SPACE_NAME_FIELD,
  })
  .strict();

/**
 * Thrown when an edit_space call would shrink a space's body below a tenth of
 * its current size without explicit confirmation. A tool-layer policy, not a store error: it
 * never reaches the database. The refused tool is named so the retry goes to the same tool.
 */
class SpaceShrinkRefusedError extends Error {
  readonly space_id: string;
  readonly current_length: number;
  readonly new_length: number;

  constructor(input: { space_id: string; current_length: number; new_length: number; tool: string }) {
    super(
      `Refusing ${input.tool} on "${input.space_id}": the new body (${String(input.new_length)} characters) ` +
        `is less than a tenth of the current body (${String(input.current_length)} characters). ` +
        `A truncated or accidental write must never silently wipe a space. If you really mean to ` +
        `replace almost all of it, call ${input.tool} again with confirm_shrink: true.`,
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
  /** This turn's search record: the links a search or page result returned, the only links a space may add. */
  webSearch: WebSearchTurnState;
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
 * edit_space path annotates; create, full-body update, and revert return the mutation
 * alone.
 */
interface WriteOutcome {
  mutation: SpaceMutationResult;
  /** Leads the result text so the model reads the name and revision before anything else. */
  action: 'Created' | 'Updated' | 'Restored';
  /** Per search-edit replacement counts, in message order among search edits; set only by the edit path. */
  edit_replacements?: number[];
  /**
   * Per-block outcomes, in message order among block edits; set only by the edit path.
   * `new_length` is the block's content length after the edit (0 when deleted) — the
   * verification signal that replaces replacement counts for anchor-addressed edits.
   */
  block_results?: { anchor: string; new_length: number; deleted: boolean }[];
}

/**
 * The link to a space in the app: the Spaces view route for that space. The result carries
 * the name and this link, never a bare id: the model links the name when it mentions the
 * space, so a reply shows the name, not an id.
 */
function spaceLink(space_id: string): string {
  return `/spaces/${encodeURIComponent(space_id)}`;
}

/**
 * The write result. `summary` is the first key, so the model reads the name and revision
 * before anything else. The space object carries the name and link but no id: a model that
 * never sees an id cannot show one to the person. Later calls address the space by its exact
 * name (space_name), which is unique among the person's spaces.
 */
function mutationResultText(result: SpaceMutationResult, outcome: Omit<WriteOutcome, 'mutation'>): string {
  const { name, revision } = result.record;
  return JSON.stringify({
    summary: `${outcome.action} space "${name}" (revision ${String(revision)}).`,
    space: {
      name,
      link: spaceLink(result.record.id),
      purpose: result.record.purpose,
      status: result.record.status,
      body: result.record.body,
      format: result.record.format,
      revision,
      created_at: result.record.created_at,
      updated_at: result.record.updated_at,
    },
    aggregate_revision: result.aggregate_revision,
    ...(outcome.edit_replacements === undefined ? {} : { edit_replacements: outcome.edit_replacements }),
    ...(outcome.block_results === undefined ? {} : { block_results: outcome.block_results }),
  });
}

/**
 * The list_spaces wire shape for one space: the name and its link, never the id. A model
 * that never sees an id addresses every space by its exact name, which is unique.
 */
function spaceSummaryWire(record: SpaceRecord) {
  const summary = SPACE_SUMMARY_SCHEMA.parse(record);
  return {
    name: summary.name,
    link: spaceLink(summary.id),
    purpose: summary.purpose,
    status: summary.status,
    format: summary.format,
    revision: summary.revision,
    created_at: summary.created_at,
    updated_at: summary.updated_at,
  };
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
 * (tenant, user, session, space), delta mode locks: further edit_space calls are refused with
 * SpaceDeltaLockedError until a successful revert_space. Any success
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
  space_name: string;
  revision: number;
  /**
   * Text before the first marker. Not addressable by anchor — there is no marker to hang an
   * edit on — so it is surfaced here (preview + length) for the post-compaction recovery
   * journey and edited with a search edit copied from get_space when needed.
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
 * marker syntax would parse as a real addressable block, and an edit_space call could
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
  protected override readonly bundle: ToolBundleName = 'spaces';

  constructor(private readonly options: SpaceCapabilityOptions) {
    super({ tracing: options.tracing });
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: LIST_SPACES_TOOL_NAME,
      description:
        "List the user's spaces without bodies: name, link, purpose, status, revision, and updated_at, plus the aggregate_revision. A space is addressed by its exact name, and names are unique. Call before create_space to check for an existing space on the same subject.",
      schema: LIST_SPACES_INPUT_SCHEMA,
      annotations: { readOnlyHint: true },
      invalidInput: spaceInvalidInput,
      handler: async () => this.read(() => this.list()),
    }),
    defineTool({
      name: GET_SPACE_TOOL_NAME,
      description:
        'Read one space by its exact space_name. Returns metadata, the aggregate_revision, and the body unless include_body is false. Call before edit_space to get the current body and revision.',
      schema: GET_SPACE_INPUT_SCHEMA,
      annotations: { readOnlyHint: true },
      invalidInput: spaceInvalidInput,
      handler: async input => this.read(() => this.get(input)),
    }),
    defineTool({
      name: CREATE_SPACE_TOOL_NAME,
      description:
        "Create a persistent space: a named page the host renders in the Spaces view. Write and change a space only with create_space and edit_space, never by editing files in the sandbox. The name must be one no existing space has: a taken name is refused, so change the existing space with edit_space instead. Use format 'markdown' for a list or note, and 'html' for a page meant to be looked at. An html body is one complete fragment with no <script>, external stylesheets, or external fonts (the host strips all three). Scripts never run on a space page, so use plain HTML and CSS. Pictures come from a page you opened or a search result. Pass body as one string with real line breaks, at most about 4,000 characters; add the rest afterwards with edit_space. Mark updatable sections with <!-- @block:name --> markers. The result gives the new space's name and link; mention the space by linking its name, never by an id.",
      schema: CREATE_SPACE_INPUT_SCHEMA,
      invalidInput: spaceInvalidInput,
      handler: async input => this.write(() => this.create(input)),
    }),
    defineTool({
      name: EDIT_SPACE_TOOL_NAME,
      description:
        'Change part of one space by its exact space_name, without resending the body. ' +
        'edits is a list of up to 50 entries, applied in order: a search entry {type: "search", search, replace} replaces every occurrence of an exact, case-sensitive substring copied verbatim from a recent get_space; a block entry {type: "block", anchor, new_content} replaces one <!-- @block:name --> section, and empty new_content deletes it. ' +
        'A search that matches nothing, or an unknown or duplicate anchor, fails the whole edit: do not retry the same entry. Re-read the space with get_space (list_blocks names its sections) and correct the entry from the fresh read. ' +
        'The new content across one call may total at most about 4,000 characters; split a bigger change into several calls. ' +
        'new_title renames the space; purpose, status, and format are optional too. ' +
        'A body that would shrink below a tenth of its size needs confirm_shrink: true.',
      schema: EDIT_SPACE_INPUT_SCHEMA,
      invalidInput: spaceInvalidInput,
      handler: async input => this.write(() => this.edit(input)),
    }),
    defineTool({
      name: REVERT_SPACE_TOOL_NAME,
      description:
        'Restore an older revision of a space as a new current revision, to undo a bad edit_space. Address the space by its exact space_name. The name, purpose, status, format, and body return to that revision; the bad content stays recoverable. expected_revision and expected_aggregate_revision are optional.',
      schema: REVERT_SPACE_INPUT_SCHEMA,
      invalidInput: spaceInvalidInput,
      handler: async input => this.write(() => this.revert(input)),
    }),
    defineTool({
      name: LIST_BLOCKS_TOOL_NAME,
      description:
        "List one space's block anchors with an 80-character preview of each, without the body. Address the space by its exact space_name. Use it after a context compaction or before edit_space. The preamble (text before the first marker) is reported separately; it has no anchor, so change it with a search edit copied from get_space.",
      schema: LIST_BLOCKS_INPUT_SCHEMA,
      annotations: { readOnlyHint: true },
      invalidInput: spaceInvalidInput,
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
    const space_id = await this.resolveSpaceId(input.space_name);
    const identity = {
      tenant_id: this.options.authority.tenantId,
      created_by: this.options.authority.userRef,
      space_id,
    };
    const space =
      input.revision === undefined
        ? await this.options.store.getSpace(identity)
        : await this.options.store.getSpaceRevision({ ...identity, revision: input.revision });
    if (space === undefined) {
      if (input.revision === undefined) {
        throw new SpaceNotFoundError({ id: space_id });
      }
      throw new SpaceRevisionNotFoundError({ id: space_id, revision: input.revision });
    }
    const aggregate_revision = await resolveAggregateRevision(this.options.store, this.options.authority, undefined);
    return { space, aggregate_revision, include_body: input.include_body };
  }

  private async create(input: z.infer<typeof CREATE_SPACE_INPUT_SCHEMA>): Promise<WriteOutcome> {
    // Names are unique: a create that would take an existing space's name is refused
    // before anything is written, so a name can never come to mean two spaces.
    await this.refuseTakenSpaceName({
      name: input.name,
      except_space_id: undefined,
      next_step: 'Pick a different name for the new space, or change the existing one with edit_space.',
    });
    // The link refusal is a safety check on the content, so it runs before the size policy:
    // a write that breaks both rules gets the safety refusal.
    refuseNewSpaceLinks({
      body: input.body,
      previousBody: '',
      format: input.format,
      web_search: this.options.webSearch,
    });
    if (input.body.length > SPACE_WRITE_MAX_LENGTH) {
      throw new SpaceWriteTooLongError({
        tool: CREATE_SPACE_TOOL_NAME,
        space_id: null,
        new_length: input.body.length,
      });
    }
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
    return { mutation, action: 'Created' };
  }

  /**
   * Every change to an existing space lives here: one edits list, entries applied in
   * message order. A missing search, a bad anchor, or a delta-computed body over
   * the size limit fails before anything is persisted, and feeds the consecutive-failure
   * breaker below.
   */
  private async edit(request: z.infer<typeof EDIT_SPACE_INPUT_SCHEMA>): Promise<WriteOutcome> {
    const input = { ...request, space_id: await this.resolveSpaceId(request.space_name) };
    // The write cap counts only new content (a search entry's replace text, a block entry's
    // new_content); the search text itself is copied from the body the model already read.
    const new_content_length = input.edits.reduce(
      (total, edit) => total + (edit.type === 'search' ? edit.replace.length : edit.new_content.length),
      0,
    );
    if (new_content_length > SPACE_WRITE_MAX_LENGTH) {
      throw new SpaceWriteTooLongError({
        tool: EDIT_SPACE_TOOL_NAME,
        space_id: input.space_id,
        new_length: new_content_length,
      });
    }
    // Refuse a locked delta before the expensive reads: the burn loop this guards against
    // would otherwise keep paying an aggregate-revision resolve plus a full-body read per
    // refusal. The name lookup above is the only store read a locked call pays.
    this.throwIfDeltaLocked(input.space_id);
    const [expected_aggregate_revision, current] = await Promise.all([
      resolveAggregateRevision(this.options.store, this.options.authority, input.expected_aggregate_revision),
      this.requireCurrentSpace(input.space_id),
    ]);
    // A rename takes a name of its own: refuse a new_title another space already has,
    // so the rename cannot recreate the two-spaces-one-name ambiguity create refuses.
    if (input.new_title !== undefined && input.new_title !== current.name) {
      await this.refuseTakenSpaceName({
        name: input.new_title,
        except_space_id: input.space_id,
        next_step: 'Pick a different new_title, or leave the name unchanged.',
      });
    }
    let body = current.body;
    const edit_replacements: number[] = [];
    const block_results: { anchor: string; new_length: number; deleted: boolean }[] = [];
    try {
      for (const [index, edit] of input.edits.entries()) {
        if (edit.type === 'search') {
          const applied = this.applySearchEdit(input.space_id, body, edit, index);
          body = applied.body;
          edit_replacements.push(applied.replacements);
        } else {
          const applied = this.applyBlockEdit(input.space_id, body, edit, index);
          body = applied.body;
          block_results.push(applied.result);
        }
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
    refuseNewSpaceLinks({
      body,
      previousBody: current.body,
      format: input.format ?? current.format,
      web_search: this.options.webSearch,
    });
    this.checkShrink(input.space_id, current, body, input.confirm_shrink, EDIT_SPACE_TOOL_NAME);
    if (body.length === 0) {
      throw new SpaceBodyEmptyError({ space_id: input.space_id });
    }
    const mutation = await this.options.store.updateSpace({
      tenant_id: this.options.authority.tenantId,
      created_by: this.options.authority.userRef,
      space_id: input.space_id,
      // On the edit path, omitted metadata means "unchanged": fall back to current values.
      name: input.new_title ?? current.name,
      purpose: input.purpose ?? current.purpose,
      status: input.status ?? current.status,
      body,
      format: input.format ?? current.format,
      expected_revision: input.expected_revision ?? current.revision,
      expected_aggregate_revision,
    });
    const outcome: WriteOutcome = { mutation, action: 'Updated' };
    if (edit_replacements.length > 0) {
      outcome.edit_replacements = edit_replacements;
    }
    if (block_results.length > 0) {
      outcome.block_results = block_results;
    }
    // Reset only after the durable write succeeds. Resetting earlier (e.g. right after the
    // local delta application) would clear the counter even when shrink validation or the
    // store write then fails — unlocking a loop that never actually converged. A delta
    // success proves the model's mental copy converged.
    this.resetDeltaBreaker(input.space_id);
    return outcome;
  }

  /** The spaces a name lookup may pick from: one page of the person's spaces. */
  private async listSpacesForLookup(): Promise<{ records: SpaceRecord[]; has_more: boolean }> {
    const listed = await this.options.store.listSpacesWithAggregate({
      tenant_id: this.options.authority.tenantId,
      created_by: this.options.authority.userRef,
      status: undefined,
      limit: SPACE_LIST_LIMIT,
    });
    return { records: listed.records, has_more: listed.has_more };
  }

  /**
   * Names are unique: refuse a name another of the person's spaces already carries, so a
   * name always picks exactly one space. `except_space_id` is the space being renamed,
   * whose own current name is not a conflict.
   */
  private async refuseTakenSpaceName(input: {
    name: string;
    except_space_id: string | undefined;
    next_step: string;
  }): Promise<void> {
    const listed = await this.listSpacesForLookup();
    const taken = listed.records.some(record => record.name === input.name && record.id !== input.except_space_id);
    if (taken) {
      throw new SpaceNameLookupError(`A space named "${input.name}" already exists. ${input.next_step}`);
    }
  }

  /**
   * The one owner of space lookup by name: every tool that addresses an existing space
   * calls it. A name is matched exactly and must be unique among the person's spaces.
   * A name shared by several spaces (only possible in vaults created before names were
   * unique) cannot pick one, and the error says what to tell the person; no id is ever
   * offered as a way out, because the model never sees one.
   */
  private async resolveSpaceId(space_name: string): Promise<string> {
    const listed = await this.listSpacesForLookup();
    // Past one page the match cannot be proven unique, so fail closed rather than pick one.
    if (listed.has_more) {
      throw new SpaceNameLookupError(
        `Too many spaces to find "${space_name}" by name for sure. Call list_spaces to see the spaces you have.`,
      );
    }
    const matches = listed.records.filter(record => record.name === space_name);
    const [only, ...rest] = matches;
    if (only === undefined) {
      throw new SpaceNameLookupError(`No space is named "${space_name}". Call list_spaces to see the spaces you have.`);
    }
    if (rest.length > 0) {
      throw new SpaceNameLookupError(
        `More than one space is named "${space_name}", and a name has to pick one space. ` +
          `Do not guess: tell the person to rename one of them in the Spaces view, then try again.`,
      );
    }
    return only.id;
  }

  /**
   * Applies one search/replace edit: every occurrence of an exact substring is replaced.
   * A missing search fails before anything is persisted.
   */
  private applySearchEdit(
    space_id: string,
    currentBody: string,
    edit: { search: string; replace: string },
    index: number,
  ): { body: string; replacements: number } {
    const parts: string[] = currentBody.split(edit.search);
    if (parts.length < 2) {
      throw new SpaceEditNotFoundError({ search: edit.search, index });
    }
    // Check the resulting length arithmetically BEFORE joining: a huge
    // replace string could otherwise OOM the process building the joined
    // string before the length check ever runs. Exact under the
    // <= SPACE_BODY_MAX_LENGTH invariant every writer enforces.
    const new_length = currentBody.length + (parts.length - 1) * (edit.replace.length - edit.search.length);
    if (new_length > SPACE_BODY_MAX_LENGTH) {
      throw new SpaceBodyTooLongError({ space_id, new_length });
    }
    return { body: parts.join(edit.replace), replacements: parts.length - 1 };
  }

  /**
   * Applies one anchor-addressed edit, parsing block structure fresh so the edit sees
   * earlier results (including anchors introduced by new_content). Unknown or duplicated
   * anchors fail closed before anything is persisted; the error lists the valid anchors.
   */
  private applyBlockEdit(
    space_id: string,
    currentBody: string,
    edit: { anchor: string; new_content: string },
    index: number,
  ): { body: string; result: { anchor: string; new_length: number; deleted: boolean } } {
    const anchor = edit.anchor.trim();
    const { blocks } = parseSpaceBlocks(currentBody);
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
        const new_length = currentBody.length - (target.contentEnd - target.markerStart);
        if (new_length > SPACE_BODY_MAX_LENGTH) {
          throw new SpaceBodyTooLongError({ space_id, new_length });
        }
        newBody = currentBody.slice(0, target.markerStart) + currentBody.slice(target.contentEnd);
        resultLength = 0;
        deleted = true;
      } else {
        // Arithmetic length check before materializing, mirroring the edits path.
        const new_length = currentBody.length - (target.contentEnd - target.contentStart) + edit.new_content.length;
        if (new_length > SPACE_BODY_MAX_LENGTH) {
          throw new SpaceBodyTooLongError({ space_id, new_length });
        }
        // Keep the marker on its own line: a line break immediately after the marker is
        // layout, not content, so preserve it instead of gluing new_content to `-->`.
        let separator = '';
        if (currentBody.startsWith('\r\n', target.contentStart)) {
          separator = '\r\n';
        } else if (currentBody.charAt(target.contentStart) === '\n') {
          separator = '\n';
        }
        newBody =
          currentBody.slice(0, target.contentStart) +
          separator +
          edit.new_content +
          currentBody.slice(target.contentEnd);
        // The preserved separator is part of the stored block content.
        resultLength = separator.length + edit.new_content.length;
        deleted = false;
      }
    }
    return { body: newBody, result: { anchor, new_length: resultLength, deleted } };
  }

  /**
   * Cheap compaction-recovery read: the space's block anchors with an 80-character preview of
   * each block's content and the anchor's occurrence count — everything edit_space needs,
   * without resending the body. A space with no markers reports the single implicit
   * AUTO_BLOCK_ANCHOR block. Text before the first marker (the preamble) is not
   * addressable by anchor, so it is surfaced separately with its preview and length.
   */
  private async listBlocks(input: z.infer<typeof LIST_BLOCKS_INPUT_SCHEMA>): Promise<ListBlocksResult> {
    const space_id = await this.resolveSpaceId(input.space_name);
    const current = await this.requireCurrentSpace(space_id);
    const { preamble, blocks } = parseSpaceBlocks(current.body);
    const preambleInfo =
      blocks.length > 0 && preamble.length > 0
        ? { preview: blockPreview(preamble), char_count: preamble.length }
        : null;
    if (blocks.length === 0) {
      return {
        space_name: input.space_name,
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
      space_name: input.space_name,
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

  /** Any success — a delta write or a revert — resets the breaker. */
  private resetDeltaBreaker(space_id: string): void {
    deltaBreaker.delete(this.deltaBreakerKey(space_id));
  }

  private async revert(input: z.infer<typeof REVERT_SPACE_INPUT_SCHEMA>): Promise<WriteOutcome> {
    const space_id = await this.resolveSpaceId(input.space_name);
    const [expected_aggregate_revision, expected_revision] = await Promise.all([
      resolveAggregateRevision(this.options.store, this.options.authority, input.expected_aggregate_revision),
      resolveSpaceRevision(this.options.store, this.options.authority, space_id, input.expected_revision),
    ]);
    const mutation = await this.options.store.revertSpace({
      tenant_id: this.options.authority.tenantId,
      created_by: this.options.authority.userRef,
      space_id,
      revision: input.revision,
      expected_revision,
      expected_aggregate_revision,
    });
    // A successful revert unlocks delta mode: the space is back at a known-good revision.
    this.resetDeltaBreaker(space_id);
    return { mutation, action: 'Restored' };
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
   * The refused tool is named so the retry goes to the same tool.
   */
  private checkShrink(
    space_id: string,
    current: SpaceRecord,
    body: string,
    confirmed: boolean | undefined,
    tool: string,
  ): void {
    if (confirmed === true || current.body.length <= 200 || body.length * 10 >= current.body.length) {
      return;
    }
    throw new SpaceShrinkRefusedError({
      space_id,
      current_length: current.body.length,
      new_length: body.length,
      tool,
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
          text: JSON.stringify({
            error:
              `${error.message}. Only recent revisions are retained. ` +
              'Call get_space without a revision to read the current revision.',
          }),
          isError: true,
        });
      }
      if (error instanceof SpaceNameLookupError) {
        return toolResultResponse({ text: JSON.stringify({ error: error.message }), isError: true });
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
        spaces: result.spaces.map(record => spaceSummaryWire(record)),
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
    const parsed = (result.include_body ? SPACE_RESULT_SCHEMA : SPACE_SUMMARY_SCHEMA).parse(result.space);
    return {
      space: {
        name: parsed.name,
        link: spaceLink(parsed.id),
        purpose: parsed.purpose,
        status: parsed.status,
        ...('body' in parsed ? { body: parsed.body } : {}),
        format: parsed.format,
        revision: parsed.revision,
        created_at: parsed.created_at,
        updated_at: parsed.updated_at,
      },
      aggregate_revision: result.aggregate_revision,
    };
  }

  /**
   * Only a known, expected write failure (a stale entity or aggregate revision, an unknown space
   * id, a revision outside the retained window, a refused dramatic shrink, a delta-computed body
   * over the size limit, an edit_space search text that is not found, a bad block anchor, or a
   * locked delta mode, all with a stable sanitized message) becomes a terminal tool error here.
   * Every error text carries the sentence that says what to do next: a refused call is never
   * a dead end. Any other exception is an unexpected infrastructure or programming failure and
   * is rethrown uncaught so its exception and stack reach the tracing wrapper instead of being
   * collapsed into an ordinary nonzero tool result.
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
          text: JSON.stringify({
            error:
              `${error.message}. Only recent revisions are retained. ` +
              'Call get_space without a revision to read the current revision.',
          }),
          isError: true,
        });
      }
      if (error instanceof SpaceNameLookupError) {
        return toolResultResponse({ text: JSON.stringify({ error: error.message }), isError: true });
      }
      if (error instanceof SpaceShrinkRefusedError) {
        return toolResultResponse({ text: JSON.stringify({ error: error.message }), isError: true });
      }
      if (error instanceof SpaceBodyTooLongError) {
        return toolResultResponse({ text: JSON.stringify({ error: error.message }), isError: true });
      }
      if (error instanceof SpaceBodyEmptyError) {
        return toolResultResponse({ text: JSON.stringify({ error: error.message }), isError: true });
      }
      if (error instanceof SpaceWriteTooLongError) {
        // The stable code rides beside the refusal text so the chat can show a plain note
        // for this refusal instead of the failure line; the text itself is unchanged.
        return toolResultResponse({
          text: JSON.stringify({ error: error.message, error_code: SPACE_WRITE_TOO_LONG_ERROR_CODE }),
          isError: true,
        });
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
      if (error instanceof SpaceLinkRefusedError) {
        return toolResultResponse({ text: JSON.stringify({ error: error.message }), isError: true });
      }
      if (error instanceof SpaceRevisionConflictError) {
        return toolResultResponse({
          text: JSON.stringify({
            error:
              `${error.message}. Call get_space to read the current revision, then send the call ` +
              'again with expected_revision set to the revision in this result.',
            revision: error.actual_revision,
          }),
          isError: true,
        });
      }
      if (error instanceof SpaceAggregateRevisionConflictError) {
        return toolResultResponse({
          text: JSON.stringify({
            error:
              `${error.message}. Call list_spaces to read the current aggregate_revision, then send ` +
              'the call again with expected_aggregate_revision set to the aggregate_revision in this result.',
            aggregate_revision: error.actual_revision,
          }),
          isError: true,
        });
      }
      throw error;
    }
  }

  private notFoundMessage(error: SpaceNotFoundError): string {
    return `${error.message}. Call list_spaces to see the spaces you have, then use the exact name.`;
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

/** Attaches `list_spaces` / `get_space` / `create_space` / `edit_space` / `revert_space` / `list_blocks` to one turn's root thread. */
export function spaceCapability(options: SpaceCapabilityOptions): AgentCapability {
  return {
    systemToolSets: [new SpaceTool(options)],
    instructionBuilders: [buildSpaceInstruction],
    bundle: 'spaces',
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
  /** Present only where schedules run (standalone); absent, no schedule tools mount. */
  schedules?: ScheduleTurnContext | undefined;
  /** Present where the chat has a model to answer with; absent, no persona tool mounts. */
  personas?: PersonaTurnContext | undefined;
  /** The request carries a new message from the person, not an approval resuming the same answer. */
  startsAnswer: boolean;
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
      usage: UsageSummaryTurnContext,
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
      usage,
    ] = args;
    super(deps, profile, persona, memory, toolOutputScreen, personaKnowledgeBlock, personaKnowledgeHits, switchNotice);
    this.#space = space;
    this.#toolImages = toolImages;
    this.#usage = usage;
  }

  readonly #space: SpaceTurnContext;
  readonly #toolImages: ToolImagesOptions;
  readonly #usage: UsageSummaryTurnContext;
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
    const google = await this.#google(input);
    const sentinel = this.#sentinel(input);
    const schedules = this.#space.schedules;
    const personas = this.#space.personas;
    return {
      ...resolved,
      extraCapabilities: [
        ...(resolved.extraCapabilities ?? []),
        spaceCapability({ ...this.#space, tracing: input.tracing, webSearch: this.webSearchTurn }),
        mapsCapability({
          tracing: input.tracing,
          logger: this.#space.logger,
          pages_scope: { tenant_id: input.tenant_id, conversation_id: input.session_id },
          timezone: this.clientTimezone,
          starts_answer: this.#space.startsAnswer,
        }),
        usageSummaryCapability({ ...this.#usage, tracing: input.tracing, timeZone: this.clientTimezone }),
        toolImagesCapability(this.#toolImages),
        ...google,
        ...(personas === undefined ? [] : [personaCapability({ ...personas, tracing: input.tracing, sentinel })]),
        ...(schedules === undefined
          ? []
          : [
              scheduleCapability({
                ...schedules,
                tracing: input.tracing,
                timeZone: this.clientTimezone,
                sentinel,
                now: () => new Date(),
              }),
            ]),
      ],
    };
  }

  #sentinel(input: Parameters<MemoryTurnResourceResolver['resolveAgentDefinition']>[0]) {
    return createSentinelHostContext({
      services: input.sentinel_services,
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      conversation_id: input.session_id,
      workspace_cwd: input.workspace_cwd ?? null,
      web_search: this.webSearchTurn,
    });
  }

  /** A store that cannot be read costs the chat its Google tools, never the chat itself. */
  async #google(input: Parameters<MemoryTurnResourceResolver['resolveAgentDefinition']>[0]) {
    const connections = this.#space.googleConnections;
    const evalFixtures = configuration.AMAN_EVAL_MODE ? evalSources() : undefined;
    if (connections === undefined && evalFixtures === undefined) {
      return [];
    }
    const owner = { tenant_id: input.tenant_id, created_by: input.created_by };
    try {
      const google = await googleCapability({
        fetchImpl: undefined,
        connections,
        evalSources: evalFixtures,
        owner,
        tracing: input.tracing,
        timeZone: this.clientTimezone,
        sentinel: this.#sentinel(input),
        attachmentStager: sandboxAttachmentStager(this.runSandbox),
        logger: this.#space.logger,
      });
      // The guided setup mounts beside the tools, but only against a real login store: in eval mode the
      // fixture account stands in for a finished connection, so there is nothing to lead there.
      const setup =
        connections === undefined || evalFixtures !== undefined
          ? undefined
          : await googleSetupCapability({ connections, owner, tracing: input.tracing });
      return [...(google === undefined ? [] : [google]), ...(setup === undefined ? [] : [setup])];
    } catch (error) {
      this.#space.logger.warn(
        'Google tools not mounted: the Google login could not be read',
        extractErrorLogFields(error),
      );
      return [];
    }
  }
}
