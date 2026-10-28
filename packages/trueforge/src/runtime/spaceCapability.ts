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
import { createHash } from 'node:crypto';
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
 * Base class for block-anchor addressing failures on the edit_space path. These are
 * terminal tool errors: nothing is persisted, and the message lists the valid anchors so
 * the model can address a real block (or re-read the space and start from its blocks)
 * instead of guessing.
 */
export class SpaceBlockAnchorError extends Error {
  readonly space_id: string;
  readonly anchor: string;
  readonly index: number;
  readonly validAnchors: string[];

  constructor(input: { space_id: string; anchor: string; index: number; validAnchors: string[] }) {
    // The anchor is model-controlled: truncate it in the message, so a pathological
    // anchor can't bloat the error (and the context) unboundedly. The full value stays
    // on the `anchor` field.
    const anchorPreview = input.anchor.length > 120 ? `${input.anchor.slice(0, 120)}…` : input.anchor;
    super(
      `${input.anchor === '' ? 'Empty' : `Unknown`} block anchor "${anchorPreview}" ` +
        `in edit_space entry #${String(input.index + 1)} for space "${input.space_id}". ` +
        `Nothing was persisted: the space is unchanged. ` +
        `Valid anchors: ${input.validAnchors.map(a => `"${a}"`).join(', ')}. ` +
        `Retry edit_space with one of the valid anchors. If none of them holds the change, ` +
        `call list_blocks to see every block with a preview of its first line, or re-read ` +
        `the space with get_space, then make the change with edit_space in parts against ` +
        `the revision you just read.`,
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
 * fails closed instead. No edit can rename one copy on its own, because the anchor names
 * them all; the honest recovery is reverting to a revision from before the duplication,
 * and the message says so instead of teaching a fix that cannot work.
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
      unique.length > 0 ? unique.map(a => `"${a}"`).join(', ') : '(none: every anchor in this space is duplicated)';
    this.message =
      `Block anchor "${input.anchor}" appears ${String(input.occurrences)} times in the body of ` +
      `space "${input.space_id}" (edit_space entry #${String(input.index + 1)}): edit_space needs ` +
      `a unique anchor, so nothing was persisted: the space is unchanged. ` +
      `No edit can rename one copy on its own, because the anchor names them all. If an earlier ` +
      `revision of the space has this anchor only once, revert_space to that revision brings the ` +
      `unique anchor back; the copies added since are lost with that revert. Otherwise, edit the ` +
      `blocks that do have unique anchors and leave the duplicated sections as they are. ` +
      `Currently unique anchors: ${uniqueList}.`;
  }
}

/**
 * Two entries in one edit_space call named the same block. All entries in one call apply
 * to the blocks of the one revision the call names, so a block can be changed by only one
 * entry per call; the model combines the change into a single entry instead.
 */
export class SpaceBlockAnchorRepeatedError extends SpaceBlockAnchorError {
  readonly firstIndex: number;

  constructor(input: { space_id: string; anchor: string; index: number; firstIndex: number; validAnchors: string[] }) {
    super(input);
    this.name = 'SpaceBlockAnchorRepeatedError';
    this.firstIndex = input.firstIndex;
    this.message =
      `Block anchor "${input.anchor}" is named by two entries in this one edit_space call ` +
      `(entries #${String(input.firstIndex + 1)} and #${String(input.index + 1)}). Entries in one call ` +
      `all apply to the blocks of the revision the call names, so one block can be changed by ` +
      `only one entry per call. Nothing was persisted: the space is unchanged. ` +
      `Combine the change into a single entry for that block and retry.`;
  }
}

/**
 * The anchor resolved, but the block there does not carry the fingerprint the entry
 * named: the model's copy of that block diverged (the usual cause is a read from before
 * the block changed or moved). The refusal says where the named content is now when
 * exactly one other block in the current revision carries that fingerprint, which is
 * the recovery the mechanism exists for; when none or several do, it says so plainly
 * and points at a fresh read. The block's current fingerprint is deliberately not
 * handed back: copying it from the refusal would turn the check into a no-op, so the
 * model re-reads and takes the fingerprint from the fresh read like any other.
 */
export class SpaceBlockFingerprintMismatchError extends SpaceBlockAnchorError {
  readonly fingerprint: string;
  readonly relocatedAnchor: string | null;
  readonly matchAnchors: string[];

  constructor(input: {
    space_id: string;
    anchor: string;
    index: number;
    validAnchors: string[];
    fingerprint: string;
    matchAnchors: string[];
  }) {
    super(input);
    this.name = 'SpaceBlockFingerprintMismatchError';
    this.fingerprint = input.fingerprint;
    this.matchAnchors = input.matchAnchors;
    const [onlyMatch] = input.matchAnchors;
    this.relocatedAnchor = onlyMatch !== undefined && input.matchAnchors.length === 1 ? onlyMatch : null;
    const head =
      `Block anchor "${input.anchor}" in edit_space entry #${String(input.index + 1)} for space ` +
      `"${input.space_id}" does not hold the content fingerprint "${input.fingerprint}" names. ` +
      `Nothing was persisted: the space is unchanged. `;
    if (this.relocatedAnchor !== null) {
      this.message =
        head +
        `That fingerprint matches block "${this.relocatedAnchor}" in the current revision: the content ` +
        `you meant is there now. Send the edit again naming anchor "${this.relocatedAnchor}" with the ` +
        `same fingerprint, or re-read the space with list_blocks first.`;
    } else if (input.matchAnchors.length > 1) {
      this.message =
        head +
        `That fingerprint matches ${String(input.matchAnchors.length)} blocks in the current revision ` +
        `(${input.matchAnchors.map(a => `"${a}"`).join(', ')}): identical copies share a fingerprint, so ` +
        `it cannot say which block moved. Re-read the space with list_blocks or get_space and take the ` +
        `anchor and fingerprint from the fresh read.`;
    } else {
      this.message =
        head +
        `No block in the current revision has that fingerprint: the content it names is gone or was ` +
        `changed since the read. Re-read the space with list_blocks or get_space and take the anchor ` +
        `and fingerprint from the fresh read.`;
    }
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
 * A terminal tool error surfaced by write().
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
 * edit_space carries up to 50 entries. An entry names one anchor (at most 200) and
 * one block fingerprint (8), and carries new content; the new content across the
 * whole call is capped at SPACE_WRITE_MAX_LENGTH by the write cap, so the entries
 * together carry at most 50 anchors and fingerprints (50 * 208) plus 4,000 of new
 * content. The metadata fields match create
 * (2,000 + 160 + 160 + 8 + 8), and expected_revision is a short number. Total:
 * 6 * (50 * 208 + 4,000 + 2,000 + 160 + 160 + 8 + 8) + 3,000 of framing = 103,416.
 *
 * What stops a runaway edit_space call in practice is the tool-call idle allowance
 * (a call that goes silent mid-write is stopped on time, not on size); this limit is
 * only the backstop for a call that keeps streaming past every valid shape.
 */
const STREAMED_JSON_ESCAPE_FACTOR = 6;
const CREATE_STREAMED_ARGUMENT_LIMIT =
  STREAMED_JSON_ESCAPE_FACTOR * (SPACE_WRITE_MAX_LENGTH + 2_000 + 160 + 160 + 8 + 8) + 2_000;
const EDIT_STREAMED_ARGUMENT_LIMIT =
  STREAMED_JSON_ESCAPE_FACTOR * (50 * 208 + SPACE_WRITE_MAX_LENGTH + 2_000 + 160 + 160 + 8 + 8) + 3_000;
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

Build a large space in steps, not in one call: one write carries at most about 4,000 characters of new content, and a write past that is refused with nothing saved. For a space with sections, first create a short skeleton: one section per part, each opened by a marker such as <!-- @block:pricing --> with a line of placeholder content under it, starting with the first marker so nothing sits before it. The create result gives the space's name and link, not an id: use that exact name later (space_name). Then fill one block per edit_space call, addressed by the marker's name, with new_content as the block's complete new content. For a long table or list with no sections, create the space with the heading and the first rows, then add the rest a few rows at a time with edit_space: call list_blocks, then insert the new rows after the last block, so the person sees it fill in as it goes. To read a space's current body, call get_space with space_name. After a context compaction, call list_blocks to recover the anchors and the revision. When you mention a space to the person, link its name to its link; never show an id. A space is always addressed by its exact name, and names are unique: create_space refuses a name an existing space already has, so pick a different name or change the existing space instead. If a create_space or edit_space call fails because its arguments did not finish, do not send the same call again: send the content in smaller parts with edit_space.

Pass body as one string with real line breaks: each table row on its own line, and a blank line as an empty line. For a list or a note, use format 'markdown'. Use format 'html' when layout, colour, or structure carries meaning, such as a tracker, board, or dashboard. An html space is one complete document fragment: no <script>, no external stylesheets, and no external fonts. The host injects a base stylesheet ahead of it: a type scale, a warm neutral palette with one accent, and a 4px spacing rhythm. Use its classes rather than writing page chrome: .page-header (a title plus a .subtitle), section or .card, .grid-2 or .grid-3, table with <thead> and <tbody>, .badge with .badge-success or .badge-warning, and <details>. Add a small <style> block only for page-specific touches. Example: \`<div class="page-header"><h1>Spain house search</h1><p class="subtitle">6 candidates</p></div><div class="grid-2"><div class="card"><h3>Budget</h3><p>€450,000</p></div></div><table><thead><tr><th>Address</th><th>Status</th></tr></thead><tbody><tr><td>Calle Mayor 1</td><td><span class="badge badge-success">Viewed</span></td></tr></tbody></table>\`.

If the web-artifacts-builder skill is mounted, follow its SKILL.md design guidance, but do not run its bundling scripts: a space is an HTML fragment the host renders, not a bundled app. Author every html space on those classes, as one self-contained document with inline CSS. The host's sanitiser decides what actually renders.

Pictures: use only picture links that a search or page result in this chat returned, never one you made up; search for a picture first if you need one. The host refuses any other link.

For a tracker (houses, tasks, candidates, or anything with several items), put one row per item in a table, with columns for what the user cares about.

There is no whole-body replacement tool: every change to an existing space goes through edit_space, which changes part of a body without resending it. Read before you edit: get_space shows the body and its revision, and list_blocks shows just the blocks, each with its anchor and a preview of its first line. Note the revision your read showed and send it as expected_revision: every edit_space call must name it, all entries in the call apply to the blocks of that one revision, and a call naming an older revision is refused with the current revision named, so re-read and send the change again. A block entry {type: 'block', anchor, fingerprint, new_content} replaces one block's content, and empty new_content deletes the block; an insert entry {type: 'insert', after, fingerprint, new_content} adds new content right after the named block, which is how you extend a table or a list. Every read shows each block's fingerprint: a short code hashed from the block's exact current content. An entry names the fingerprint its read showed for that block. If the block at the anchor no longer carries that fingerprint, the edit is refused and nothing is saved: when exactly one other block now carries it, the refusal names that block's anchor, because the content you meant has moved; otherwise re-read and take the anchor and fingerprint from the fresh read. Identical blocks share a fingerprint, and that is fine: the anchor still says which block you mean, and the fingerprint only checks the content. A successful edit returns the new revision and the fresh block outline: chain the next edit from those instead of re-reading. One block can be named by only one entry per call. Blocks come from the body's own structure: in a space with section markers, the anchors are the marker names; in any other space the body is split into blocks by its headings, paragraphs, list groups, and table row groups, and the anchors are b1, b2, and so on in order. Text before the first marker in a marked space is a preamble with no anchor: keep it short, and never put anything there that needs changing. An unknown or duplicate anchor fails the whole edit and the error lists the valid anchors, so re-read and address a real block instead of guessing. A marker inside a fenced code block or a <pre> or <code> element is text, not a block. edit_space can also change the space's purpose, status, or format, and rename it: pass new_title for the new name. After ${String(DELTA_BREAKER_TRIP_AFTER_FAILURES)} consecutive failed edit_space calls on one space, edit_space is refused until it is unlocked: revert_space with the space's current revision unlocks it without changing the body. Every change keeps the previous revision: to undo a bad change, call revert_space rather than rebuilding the content from memory. expected_aggregate_revision is optional: leave it out; if it is stale, the error names the current value, so retry once with it.
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
/**
 * The fingerprint an edit entry names: the eight hex characters a read (list_blocks,
 * get_space, or a successful edit's result) showed for the block as read. The shape is
 * enforced here so a miscopied fingerprint is a guided validation error; a well-formed
 * fingerprint that names different content is the mismatch refusal in applyEditEntries.
 */
const SPACE_FINGERPRINT_FIELD = z
  .string()
  .regex(/^[0-9a-f]{8}$/, 'must be the 8-character fingerprint a read returned for the block');
/**
 * One anchor-addressed entry of an edit_space call: `anchor` names one block of the body
 * at the revision the call names (a `<!-- @block:name -->` marker's name, or the ordinal
 * anchor list_blocks gives a block of a body without markers), `fingerprint` is that
 * block's fingerprint as read, and `new_content` replaces that block's content
 * wholesale. Empty `new_content` deletes the block.
 */
const SPACE_BLOCK_EDIT_SCHEMA = z
  .object({
    type: z.literal('block'),
    // Anchors are short names by convention; the max bounds how much
    // model-controlled text can flow into error messages.
    anchor: z.string().min(1).max(200),
    fingerprint: SPACE_FINGERPRINT_FIELD,
    new_content: z.string(),
  })
  .strict();
/**
 * One insert entry of an edit_space call: `new_content` is added as new block content
 * right after the block `after` names, at the revision the call names, and `fingerprint`
 * is that block's fingerprint as read, checked the same way a block entry's is. This is
 * how a table or a list grows: the new rows go after the last block without resending
 * the rows that are already there.
 */
const SPACE_INSERT_EDIT_SCHEMA = z
  .object({
    type: z.literal('insert'),
    after: z.string().min(1).max(200),
    fingerprint: SPACE_FINGERPRINT_FIELD,
    new_content: z.string().min(1),
  })
  .strict();
/** The one edit list shape: every entry names its own kind, so block and insert entries never mix ambiguously. */
const SPACE_EDIT_ENTRY_SCHEMA = z.discriminatedUnion('type', [SPACE_BLOCK_EDIT_SCHEMA, SPACE_INSERT_EDIT_SCHEMA]);
type SpaceEditEntry = z.infer<typeof SPACE_EDIT_ENTRY_SCHEMA>;
/**
 * On the edit path, new_title/purpose/status/format are optional: omit them to leave the
 * metadata unchanged, provide them to change specific fields. The edits list itself is
 * required: an edit call with nothing to change is a wasted step, not a metadata-only update.
 * The rename field is new_title, never name: name is create_space's title field, and keeping
 * the two apart means a call can never confuse which space it means with what to call it.
 * expected_revision is required: every entry addresses a block of one stated revision, so
 * a call that does not say which revision its anchors belong to cannot be applied safely.
 */
const EDIT_SPACE_INPUT_SCHEMA = z
  .object({
    space_name: SPACE_NAME_FIELD,
    new_title: z.string().trim().min(1).max(160).optional(),
    purpose: z.string().trim().min(1).max(2_000).optional(),
    status: SpaceStatusSchema.optional(),
    format: SpaceFormatSchema.optional(),
    edits: z.array(SPACE_EDIT_ENTRY_SCHEMA).min(1).max(50),
    expected_revision: z.number().int().positive(),
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
  /**
   * Per-entry outcomes, in message order; set only by the edit path. `anchor` is the
   * block the entry named (for an insert entry, the block the new content went after),
   * `new_length` is that entry's content length after the edit (0 when the entry deleted
   * its block), and `deleted` marks a block entry that removed its block.
   */
  block_results?: { anchor: string; new_length: number; deleted: boolean }[];
  /**
   * The fresh block outline of the new body, at the new revision; set only by the edit
   * path. The model's next edit chains from these anchors and fingerprints instead of
   * a re-read.
   */
  blocks?: { anchor: string; fingerprint: string; preview: string; occurrences: number }[];
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
    ...(outcome.block_results === undefined ? {} : { block_results: outcome.block_results }),
    ...(outcome.blocks === undefined ? {} : { blocks: outcome.blocks }),
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
 * Consecutive-failure circuit breaker for delta updates. A failed block edit (a bad
 * block anchor, a stale revision, or a computed body over the size limit) means the
 * model's mental copy of the body diverged; recomputed deltas do not
 * converge, and each retry burns a full model step: the failure loop that motivated this.
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
   * Text before the first marker of a marked body. Not addressable by anchor: there is
   * no marker to hang an edit on, so it is surfaced here (preview + length) for the
   * post-compaction recovery journey, and the model is told to keep it short and stable.
   * Null when the body starts with a marker, and null for a body with no markers at
   * all: such a body is split into structural blocks that cover it whole.
   */
  preamble: { preview: string; char_count: number } | null;
  blocks: { anchor: string; fingerprint: string; preview: string; occurrences: number }[];
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
function uniqueBlockAnchors(blocks: readonly { anchor: string }[]): string[] {
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

/**
 * One addressable block of a space body at one revision: a slice of the body an
 * edit_space entry can name. A marked block keeps its marker's name as the anchor; a
 * block of a body without markers gets an ordinal anchor (b1, b2, and so on) in order.
 * Ordinals are defined against one revision's segmentation: the same body always
 * segments the same way, and a changed body is a new revision whose anchors the model
 * reads fresh, so an ordinal is never resolved against a body the model has not seen.
 */
interface SpaceSegment {
  anchor: string;
  /** Index where this block's slice of the body starts (the marker's `<` for a marked block). */
  start: number;
  /** Index where the replaceable content starts (just past the marker for a marked block). */
  coreStart: number;
  /** Index where the replaceable content ends; a trailing separator sits between here and `end`. */
  coreEnd: number;
  /** Index where this block's slice ends: the next block's start, or the end of the body. */
  end: number;
  /** True for a block a `<!-- @block:name -->` marker opens; false for a structural block. */
  marked: boolean;
}

/** The most characters one block of a table holds: the header plus one group of rows. */
const TABLE_GROUP_MAX_LENGTH = 2_000;

/**
 * The fingerprint of one block: eight hex characters hashed from the block's exact
 * current content. The one canonical helper: every place a block is shown (list_blocks,
 * get_space, the outline a successful edit returns) carries the fingerprint this
 * computes, and an edit entry must name it back. Identical blocks share a fingerprint
 * by construction: the fingerprint verifies what content is at an anchor, and the
 * anchor alone says which block is meant, so the fingerprint is a check, never an
 * address. Eight characters is short enough to copy exactly and long enough that the
 * blocks of one body practically never collide by accident.
 */
export function blockFingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Segments a body with no markers into structural blocks: each heading on its own,
 * each paragraph and list group (a run of non-blank lines), and for
 * a table the header plus row groups of at most TABLE_GROUP_MAX_LENGTH characters, so
 * replacing one group stays well under the per-write new-content cap. Classification
 * reads the documentation-masked lines, so a heading or table row inside a fenced code
 * block or a <pre> or <code> element is text, not structure. The blocks tile the body:
 * each block's slice runs to the next block's start, and the whitespace at a slice's
 * end is its separator, which a replacement preserves.
 */
function structuralSegments(body: string): SpaceSegment[] {
  if (body.length === 0) {
    return [{ anchor: 'b1', start: 0, coreStart: 0, coreEnd: 0, end: 0, marked: false }];
  }
  const maskedLines = maskDocumentationRegions(body).split('\n');
  const lines = body.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const isBlank = (index: number): boolean => (lines[index] ?? '').trim() === '';
  const isHeading = (index: number): boolean => /^#{1,6}(\s|$)/.test(maskedLines[index] ?? '');
  const isTableRow = (index: number): boolean => (maskedLines[index] ?? '').trim().startsWith('|');
  const isSeparatorRow = (index: number): boolean => {
    const trimmed = (maskedLines[index] ?? '').trim();
    return trimmed.startsWith('|') && trimmed.includes('-') && /^\|[\s:|-]*$/.test(trimmed);
  };

  // Runs: stretches of non-blank lines. A heading is a run of its own, one line:
  // changing a heading never means resending the section under it, and the content
  // under a heading starts a fresh run of its own.
  const runs: { first: number; last: number }[] = [];
  let runStart = -1;
  const closeRun = (endLine: number): void => {
    if (runStart >= 0) {
      runs.push({ first: runStart, last: endLine });
      runStart = -1;
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    if (isBlank(index)) {
      closeRun(index);
    } else if (isHeading(index)) {
      closeRun(index);
      runs.push({ first: index, last: index + 1 });
    } else if (runStart < 0) {
      runStart = index;
    }
  }
  closeRun(lines.length);

  // Pieces: each run splits at its table regions, and each table region splits into
  // groups under the length budget, the header and its separator row pinned together
  // in the first group.
  const pieces: { first: number; last: number }[] = [];
  for (const run of runs) {
    let index = run.first;
    while (index < run.last) {
      if (!isTableRow(index)) {
        let end = index;
        while (end < run.last && !isTableRow(end)) {
          end += 1;
        }
        pieces.push({ first: index, last: end });
        index = end;
        continue;
      }
      let regionEnd = index;
      while (regionEnd < run.last && isTableRow(regionEnd)) {
        regionEnd += 1;
      }
      const pinned = regionEnd - index >= 2 && isSeparatorRow(index + 1) ? 2 : 0;
      let groupStart = index;
      while (groupStart < regionEnd) {
        let groupEnd = groupStart;
        let groupLength = 0;
        while (groupEnd < regionEnd) {
          const lineLength = (lines[groupEnd] ?? '').length;
          const nextLength = groupEnd === groupStart ? lineLength : groupLength + 1 + lineLength;
          const pinnedLine = groupStart === index && groupEnd - groupStart < pinned;
          if (groupEnd > groupStart && !pinnedLine && nextLength > TABLE_GROUP_MAX_LENGTH) {
            break;
          }
          groupLength = nextLength;
          groupEnd += 1;
        }
        pieces.push({ first: groupStart, last: groupEnd });
        groupStart = groupEnd;
      }
      index = regionEnd;
    }
  }

  if (pieces.length === 0) {
    // A body of blank lines only: one block covering it whole.
    return [{ anchor: 'b1', start: 0, coreStart: 0, coreEnd: body.length, end: body.length, marked: false }];
  }
  return pieces.map((piece, index) => {
    const start = index === 0 ? 0 : (lineStarts[piece.first] ?? body.length);
    const next = pieces[index + 1];
    const end = next === undefined ? body.length : (lineStarts[next.first] ?? body.length);
    const slice = body.slice(start, end);
    // The separator is the slice's trailing whitespace, kept only when it contains a
    // line break and leaves a non-empty core: a replacement preserves it, so the gap
    // between this block and the next survives an edit.
    const suffix = /\s+$/.exec(slice)?.[0] ?? '';
    const separatorLength = suffix.includes('\n') && suffix.length < slice.length ? suffix.length : 0;
    return {
      anchor: `b${String(index + 1)}`,
      start,
      coreStart: start,
      coreEnd: end - separatorLength,
      end,
      marked: false,
    };
  });
}

/**
 * The blocks of one body at one revision. A body with markers keeps today's behaviour
 * exactly: the marked blocks are the blocks, with their names as anchors, and the text
 * before the first marker is a preamble no anchor names. A body with no markers is
 * segmented by its structure instead, and the blocks cover it whole.
 */
function segmentSpaceBody(body: string): { preamble: string; segments: SpaceSegment[] } {
  const { preamble, blocks } = parseSpaceBlocks(body);
  if (blocks.length > 0) {
    return {
      preamble,
      segments: blocks.map(block => ({
        anchor: block.anchor,
        start: block.markerStart,
        coreStart: block.contentStart,
        coreEnd: block.contentEnd,
        end: block.contentEnd,
        marked: true,
      })),
    };
  }
  return { preamble: '', segments: structuralSegments(body) };
}

/** The line break a marked block's stored content starts with, when it starts with one: layout, not content. */
function markedLeadSeparator(body: string, segment: SpaceSegment): string {
  if (body.startsWith('\r\n', segment.coreStart)) {
    return '\r\n';
  }
  return body.charAt(segment.coreStart) === '\n' ? '\n' : '';
}

/** The separator between one block's content and the next block: whitespace the block's slice ends with. */
function segmentTrailingSeparator(body: string, segment: SpaceSegment): string {
  if (!segment.marked) {
    return body.slice(segment.coreEnd, segment.end);
  }
  const suffix = /\s+$/.exec(body.slice(segment.start, segment.end))?.[0] ?? '';
  return suffix.includes('\n') ? suffix : '';
}

/**
 * Applies one edit_space call's entries, all against the segmentation of the body the
 * call names (the current body at the revision it checked): entries never see each
 * other's results, and one block can be named by only one entry. Unknown or duplicated
 * anchors, and a fingerprint that does not match the block at its anchor, fail closed
 * before anything is persisted, and the resulting length is
 * checked arithmetically before the new body is built, mirroring the other edit paths.
 */
function applyEditEntries(input: { space_id: string; body: string; edits: readonly SpaceEditEntry[] }): {
  body: string;
  block_results: { anchor: string; new_length: number; deleted: boolean }[];
} {
  const { space_id, body, edits } = input;
  const { preamble, segments } = segmentSpaceBody(body);
  const validAnchors = uniqueBlockAnchors(segments);
  const byAnchor = new Map<string, SpaceSegment[]>();
  for (const segment of segments) {
    const matches = byAnchor.get(segment.anchor) ?? [];
    matches.push(segment);
    byAnchor.set(segment.anchor, matches);
  }
  const replacements = new Map<SpaceSegment, string>();
  const deletions = new Set<SpaceSegment>();
  const inserts = new Map<SpaceSegment, string>();
  const namedAt = new Map<string, number>();
  const block_results: { anchor: string; new_length: number; deleted: boolean }[] = [];
  for (const [index, entry] of edits.entries()) {
    const anchor = (entry.type === 'block' ? entry.anchor : entry.after).trim();
    const firstNamedAt = namedAt.get(anchor);
    if (firstNamedAt !== undefined) {
      throw new SpaceBlockAnchorRepeatedError({ space_id, anchor, index, firstIndex: firstNamedAt, validAnchors });
    }
    namedAt.set(anchor, index);
    const matches = byAnchor.get(anchor) ?? [];
    const target = matches[0];
    if (target === undefined) {
      throw new SpaceBlockAnchorNotFoundError({ space_id, anchor, index, validAnchors });
    }
    if (matches.length > 1) {
      throw new SpaceBlockAnchorDuplicateError({
        space_id,
        anchor,
        index,
        occurrences: matches.length,
        validAnchors,
      });
    }
    // The anchor and the call's revision say where the edit applies; the fingerprint
    // verifies what is there. A block whose content is not the content the model read
    // refuses, and the refusal looks for that content's fingerprint in the other
    // blocks of this same revision, so a block that moved gets its new anchor named.
    const targetFingerprint = blockFingerprint(body.slice(target.coreStart, target.coreEnd));
    if (entry.fingerprint !== targetFingerprint) {
      const matchAnchors = segments
        .filter(
          segment =>
            segment !== target &&
            blockFingerprint(body.slice(segment.coreStart, segment.coreEnd)) === entry.fingerprint,
        )
        .map(segment => segment.anchor);
      throw new SpaceBlockFingerprintMismatchError({
        space_id,
        anchor,
        index,
        validAnchors,
        fingerprint: entry.fingerprint,
        matchAnchors,
      });
    }
    if (entry.type === 'block') {
      if (entry.new_content === '') {
        deletions.add(target);
        block_results.push({ anchor, new_length: 0, deleted: true });
      } else {
        replacements.set(target, entry.new_content);
        const leadLength = target.marked ? markedLeadSeparator(body, target).length : 0;
        block_results.push({ anchor, new_length: leadLength + entry.new_content.length, deleted: false });
      }
    } else {
      inserts.set(target, entry.new_content);
      block_results.push({ anchor, new_length: entry.new_content.length, deleted: false });
    }
  }

  // The text an insert entry adds after its block, placed between the block's content
  // and its trailing separator, so what follows the block keeps its distance. When the
  // block's last line and the new content's first line are both table rows, the new
  // content continues the table, so a single line break joins them and the table stays
  // one table. Otherwise the block's own separator is the joiner; a block that ends the
  // body with no separator after it gives the new content one of its own in front: a
  // blank line after a structural block, one line break after a marked block.
  const lastLineOf = (text: string): string => {
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if ((lines[index] ?? '').trim() !== '') {
        return lines[index] ?? '';
      }
    }
    return '';
  };
  const firstLineOf = (text: string): string => {
    for (const line of text.split('\n')) {
      if (line.trim() !== '') {
        return line;
      }
    }
    return '';
  };
  const insertText = (segment: SpaceSegment, content: string): string => {
    const core = body.slice(segment.coreStart, segment.coreEnd);
    const continuesTable = lastLineOf(core).trim().startsWith('|') && firstLineOf(content).trim().startsWith('|');
    if (continuesTable) {
      return `\n${content}`;
    }
    const separator = segmentTrailingSeparator(body, segment);
    if (separator !== '') {
      return separator + content;
    }
    return segment.marked ? `\n${content}` : `\n\n${content}`;
  };
  let new_length = body.length;
  for (const [segment, content] of replacements) {
    const leadLength = segment.marked ? markedLeadSeparator(body, segment).length : 0;
    new_length += leadLength + content.length - (segment.coreEnd - segment.coreStart);
  }
  for (const segment of deletions) {
    new_length -= segment.end - segment.start;
  }
  for (const [segment, content] of inserts) {
    new_length += insertText(segment, content).length;
  }
  if (new_length > SPACE_BODY_MAX_LENGTH) {
    throw new SpaceBodyTooLongError({ space_id, new_length });
  }

  const parts: string[] = [preamble];
  for (const segment of segments) {
    if (deletions.has(segment)) {
      continue;
    }
    const replacement = replacements.get(segment);
    const inserted = inserts.get(segment);
    // A replaced marked block emits its marker, the preserved line break after it, and
    // the new content: the old content, its trailing line break included, is gone, as
    // it was when one block edit applied on its own. Any other block emits its content
    // first and its trailing separator last, with an insert entry's text in between.
    let coreEmission: string;
    let tailEmission: string;
    if (replacement !== undefined && segment.marked) {
      coreEmission = body.slice(segment.start, segment.coreStart) + markedLeadSeparator(body, segment) + replacement;
      tailEmission = '';
    } else if (replacement !== undefined) {
      coreEmission = replacement;
      tailEmission = body.slice(segment.coreEnd, segment.end);
    } else if (segment.marked) {
      const separator = segmentTrailingSeparator(body, segment);
      coreEmission = body.slice(segment.start, segment.end - separator.length);
      tailEmission = separator;
    } else {
      coreEmission = body.slice(segment.coreStart, segment.coreEnd);
      tailEmission = body.slice(segment.coreEnd, segment.end);
    }
    parts.push(coreEmission + (inserted === undefined ? '' : insertText(segment, inserted)) + tailEmission);
  }
  return { body: parts.join(''), block_results };
}

/**
 * The block outline of one body at one revision: every block's anchor, fingerprint,
 * and a preview of its first line, in order, plus the preamble of a marked body. list_blocks returns
 * it on its own; a successful edit_space returns it too (see WriteOutcome), so the
 * model can chain its next edit from what the edit handed back instead of paying a
 * full re-read between edits.
 */
function blockOutline(body: string): {
  preamble: { preview: string; char_count: number } | null;
  blocks: { anchor: string; fingerprint: string; preview: string; occurrences: number }[];
} {
  const { preamble, segments } = segmentSpaceBody(body);
  const marked = segments[0]?.marked === true;
  if (!marked) {
    return {
      preamble: null,
      blocks: segments.map(segment => {
        const content = body.slice(segment.coreStart, segment.coreEnd);
        return {
          anchor: segment.anchor,
          fingerprint: blockFingerprint(content),
          preview: blockPreview(content),
          occurrences: 1,
        };
      }),
    };
  }
  const byAnchor = new Map<string, { fingerprint: string; preview: string; occurrences: number }>();
  for (const segment of segments) {
    const content = body.slice(segment.coreStart, segment.coreEnd);
    const existing = byAnchor.get(segment.anchor);
    if (existing === undefined) {
      byAnchor.set(segment.anchor, {
        fingerprint: blockFingerprint(content),
        preview: blockPreview(content),
        occurrences: 1,
      });
    } else {
      existing.occurrences += 1;
    }
  }
  return {
    preamble: preamble.length > 0 ? { preview: blockPreview(preamble), char_count: preamble.length } : null,
    blocks: [...byAnchor.entries()].map(([anchor, info]) => ({ anchor, ...info })),
  };
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
        "Read one space by its exact space_name. Returns metadata, the aggregate_revision, the block outline (each block's anchor, fingerprint, and a preview of its first line), and the body unless include_body is false. Call before edit_space to get the current body, revision, and fingerprints.",
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
        'Read the space first (get_space, or list_blocks for just its blocks) and send expected_revision set to the revision that read showed: every entry addresses a block of that one revision, and a call naming an older revision is refused with the current one. ' +
        'edits is a list of up to 50 entries: a block entry {type: "block", anchor, fingerprint, new_content} replaces the content of the block the anchor names, and empty new_content deletes it; an insert entry {type: "insert", after, fingerprint, new_content} adds new content right after the named block. One block can be named by only one entry per call. ' +
        "fingerprint is the block's fingerprint as that read showed it: a short code hashed from the block's exact current content. An entry whose fingerprint does not match the block at its anchor is refused and nothing is saved; when exactly one other block now carries that fingerprint, the refusal names that block's anchor. " +
        'Anchors come from list_blocks: the name of a <!-- @block:name --> section, or b1, b2, and so on for the blocks a body without markers is split into. ' +
        'An unknown or duplicate anchor fails the whole edit and nothing is saved: do not retry the same entry. Re-read the space and correct the entry from the fresh read. ' +
        'The new content across one call may total at most about 4,000 characters; split a bigger change into several calls. ' +
        'A successful edit returns the new revision and the fresh block outline, so the next edit can chain from them without a re-read. ' +
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
        "List one space's blocks with an 80-character preview of each, without the body. Address the space by its exact space_name. Every block has an anchor edit_space can name: the name of its <!-- @block:name --> marker, or b1, b2, and so on for the blocks a body without markers is split into (its headings, paragraphs, list groups, and table row groups). Every block also carries a fingerprint: a short code hashed from its exact current content, which an edit entry names back so the host can check the block still holds what you read. The result names the revision the anchors and fingerprints belong to: send it as expected_revision when you edit. Use it after a context compaction or before edit_space. In a marked space, the text before the first marker is the preamble: it is reported separately and has no anchor, so keep it short and stable.",
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
   * Every change to an existing space lives here: one edits list, every entry applied
   * against the blocks of the one revision the call names. A bad anchor, a stale
   * revision, or a delta-computed body over the size limit fails before anything is
   * persisted, and feeds the consecutive-failure breaker below.
   */
  private async edit(request: z.infer<typeof EDIT_SPACE_INPUT_SCHEMA>): Promise<WriteOutcome> {
    const input = { ...request, space_id: await this.resolveSpaceId(request.space_name) };
    // The write cap counts only new content: every entry's new_content, and nothing else.
    const new_content_length = input.edits.reduce((total, edit) => total + edit.new_content.length, 0);
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
    // The entries address blocks of the revision the call names, so a space that has
    // moved since the model's read refuses here, before any anchor is resolved against
    // a body the model has not seen. The refusal names the current revision, and it
    // counts as a failed delta like any other: the model's copy diverged.
    if (input.expected_revision !== current.revision) {
      this.recordDeltaFailure(input.space_id);
      throw new SpaceRevisionConflictError({
        id: input.space_id,
        expected_revision: input.expected_revision,
        actual_revision: current.revision,
      });
    }
    // A rename takes a name of its own: refuse a new_title another space already has,
    // so the rename cannot recreate the two-spaces-one-name ambiguity create refuses.
    if (input.new_title !== undefined && input.new_title !== current.name) {
      await this.refuseTakenSpaceName({
        name: input.new_title,
        except_space_id: input.space_id,
        next_step: 'Pick a different new_title, or leave the name unchanged.',
      });
    }
    let body: string;
    let block_results: { anchor: string; new_length: number; deleted: boolean }[];
    try {
      const applied = applyEditEntries({ space_id: input.space_id, body: current.body, edits: input.edits });
      body = applied.body;
      block_results = applied.block_results;
    } catch (error) {
      if (error instanceof SpaceBlockAnchorError || error instanceof SpaceBodyTooLongError) {
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
      expected_revision: input.expected_revision,
      expected_aggregate_revision,
    });
    const outcome: WriteOutcome = { mutation, action: 'Updated' };
    if (block_results.length > 0) {
      outcome.block_results = block_results;
    }
    // The fresh outline of the new body, at the new revision: the next edit chains
    // from these anchors instead of paying a re-read first.
    outcome.blocks = blockOutline(mutation.record.body).blocks;
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
          `Do not guess: tell the person to delete one of them in the Spaces view, then try again.`,
      );
    }
    return only.id;
  }

  /**
   * Cheap compaction-recovery read: the space's blocks at its current revision, each
   * with its anchor and an 80-character preview of its first line, without resending
   * the body. A marked body lists its marker names (with an occurrence count, so a
   * duplicated name is visible before an edit trips over it) and surfaces its preamble
   * separately; a body with no markers lists the structural blocks its headings,
   * paragraphs, list groups, and table row groups make, with ordinal anchors.
   */
  private async listBlocks(input: z.infer<typeof LIST_BLOCKS_INPUT_SCHEMA>): Promise<ListBlocksResult> {
    const space_id = await this.resolveSpaceId(input.space_name);
    const current = await this.requireCurrentSpace(space_id);
    const outline = blockOutline(current.body);
    return {
      space_name: input.space_name,
      revision: current.revision,
      preamble: outline.preamble,
      blocks: outline.blocks,
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
   * Records one failed delta update (bad anchor, stale revision, or delta-computed body over
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
    // A revert restores the name the space carried at that revision, so it takes a name
    // just like create and rename do: refuse before anything is written when another
    // space holds that name now, so a name can never come to mean two spaces. A missing
    // revision reads as undefined here and keeps the store's not-found refusal below.
    const historical = await this.options.store.getSpaceRevision({
      tenant_id: this.options.authority.tenantId,
      created_by: this.options.authority.userRef,
      space_id,
      revision: input.revision,
    });
    if (historical !== undefined) {
      await this.refuseTakenSpaceName({
        name: historical.name,
        except_space_id: space_id,
        next_step: 'Rename the space that has that name now with edit_space, then try again.',
      });
    }
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
      // The block outline rides along even when the body is omitted: the anchors and
      // fingerprints are what an edit names, and they are cheap without the body.
      blocks: blockOutline(result.space.body).blocks,
      aggregate_revision: result.aggregate_revision,
    };
  }

  /**
   * Only a known, expected write failure (a stale entity or aggregate revision, an unknown space
   * id, a revision outside the retained window, a refused dramatic shrink, a delta-computed body
   * over the size limit, a bad block anchor, or a locked delta mode, all with a stable sanitized
   * message) becomes a terminal tool error here.
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
