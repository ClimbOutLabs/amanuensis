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
  SPACE_WRITE_NOTHING_SAVED_FIELD,
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
  SPACE_WRITE_GUIDANCE_MAX_LENGTH,
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
import { maskDocumentationRegions } from './spaceDocumentationMask';
import {
  dropDuplicateRows,
  keysOfTableEndingAt,
  skippedRowsSentence,
  skippedRowsWithin,
  type SkippedRow,
} from './spaceDuplicateRows';
import { spaceFormatNotes } from './spaceFormatNotes';
import { dropUnseenSpaceLinks, SpaceLinkRefusedError, type DroppedLinks } from './spaceLinks';
import { isTableRow, isTableSeparatorRow, orphanedRowGroupCount, tableRowEntries } from './spaceTableRows';
import { prefixWithinCap, type WritePrefix } from './spaceWritePrefix';
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
 * An edit entry named something that is not the 8-character fingerprint a read shows.
 * The refusal hands the current outline back (the read the model would make next) so the
 * retry costs no extra step. It is not a delta failure: the space and the model's copy
 * are fine, only the code was missing or miscopied.
 */
export class SpaceFingerprintFormatError extends Error {
  readonly revision: number;
  readonly blocks: BlockOutlineEntry[];

  constructor(input: { index: number; fingerprint: string; revision: number; blocks: BlockOutlineEntry[] }) {
    super(
      `Entry #${String(input.index + 1)} names fingerprint "${input.fingerprint}" but a fingerprint is the ` +
        `8-character code a read shows next to each block. The current blocks are below: send the edit again ` +
        `with the anchor and fingerprint of the block you mean, or use an append entry to add content at the end.`,
    );
    this.name = 'SpaceFingerprintFormatError';
    this.revision = input.revision;
    this.blocks = input.blocks;
  }
}

/**
 * The call named a revision the space is no longer at, and the edit could not be shown
 * to land where the model meant. Nothing is saved. The current outline rides along so
 * the retry needs no re-read. Also raised when the store's own revision check loses a
 * race with another writer after the read.
 */
export class SpaceStaleRevisionError extends Error {
  readonly revision: number;
  readonly blocks: BlockOutlineEntry[];

  constructor(input: {
    expected_revision: number;
    actual_revision: number;
    blocks: BlockOutlineEntry[];
    cause?: unknown;
  }) {
    super(
      `The space is at revision ${String(input.actual_revision)}, not ${String(input.expected_revision)}. ` +
        `The anchors and fingerprints below are current: send the edit again with expected_revision ` +
        `${String(input.actual_revision)} and these fingerprints.`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = 'SpaceStaleRevisionError';
    this.revision = input.actual_revision;
    this.blocks = input.blocks;
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

/** Thrown when an edit_space call would leave the space exactly as it is. Nothing is saved. */
export class SpaceEditUnchangedError extends Error {
  constructor(leftOut?: Pick<DroppedLinks, 'links' | 'pictures'>) {
    super(
      leftOut === undefined
        ? 'This edit changes nothing: the blocks already hold exactly that content, so nothing was saved. ' +
            'Change the content, or tell the person the space already reads this way.'
        : `Nothing was saved. ${leftOutSentence(leftOut)} The rest of the edit changes nothing, so the space reads the same.`,
    );
    this.name = 'SpaceEditUnchangedError';
  }
}

/**
 * Thrown when every table row a call adds is already in the table. Nothing is persisted,
 * and it is not a delta failure: the model's copy of the table is only out of date.
 */
export class SpaceDuplicateRowsError extends Error {
  constructor() {
    super(
      'Every row in this call is already in the table, so nothing was saved. ' +
        'Send only rows that are not there yet, or tell the person the table is complete.',
    );
    this.name = 'SpaceDuplicateRowsError';
  }
}

/** The one number a write holds, with its shape in rows and lines so a model can count. */
const SPACE_WRITE_SIZE_TEXT = `about ${SPACE_WRITE_GUIDANCE_MAX_LENGTH.toLocaleString('en-US')} characters: about 25 table rows or 40 short lines`;

/**
 * Thrown when one write call carries more new content than SPACE_WRITE_MAX_LENGTH. A
 * tool-layer policy, not a store error: it never reaches the database. It exists because
 * models stall while writing very long tool arguments, so a space is built in parts: the
 * refusal names the number the model is told and the next step, and nothing is persisted.
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
        `and one write may carry at most ${SPACE_WRITE_SIZE_TEXT}. Nothing was persisted. ${next}`,
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

Build a large space in steps, not in one call: one write carries at most ${SPACE_WRITE_SIZE_TEXT}. A create, or an edit whose one entry adds rows or fills a short placeholder, saves only the leading lines that fit when it runs past the limit; any other write past it is refused with nothing saved. For a space with sections, first create a short skeleton: one section per part, each opened by a marker such as <!-- @block:pricing --> with a line of placeholder content under it, starting with the first marker so nothing sits before it. The create result gives the space's name and link, not an id: use that exact name later (space_name). Then fill one block per edit_space call, addressed by the marker's name, with new_content as the block's complete new content. For a long table or list with no sections, create the space with the heading and the first rows, then add the rest a few rows at a time with append entries in edit_space, so the person sees it fill in as it goes. To read a space's current body, call get_space with space_name. After a context compaction, call list_blocks to recover the anchors and the revision. When you mention a space to the person, link its name to its link; never show an id. A space is always addressed by its exact name, and names are unique: create_space refuses a name an existing space already has, so pick a different name or change the existing space instead. If a create_space or edit_space call fails because its arguments did not finish, do not send the same call again: send the content in smaller parts with edit_space. A result may carry format_notes: plain sentences about how the body renders. Fix what they name if you can, then finish; do not resend an edit that changes nothing.

Pass body as one string with real line breaks: each table row on its own line, and a blank line as an empty line. For a list or a note, use format 'markdown'. Use format 'html' when layout, colour, or structure carries meaning, such as a tracker, board, or dashboard. An html space is one complete document fragment: no <script>, no external stylesheets, and no external fonts. The host injects a base stylesheet ahead of it: a type scale, a warm neutral palette with one accent, and a 4px spacing rhythm. Use its classes rather than writing page chrome: .page-header (a title plus a .subtitle), section or .card, .grid-2 or .grid-3, table with <thead> and <tbody>, .badge with .badge-success or .badge-warning, and <details>. Add a small <style> block only for page-specific touches. Example: \`<div class="page-header"><h1>Spain house search</h1><p class="subtitle">6 candidates</p></div><div class="grid-2"><div class="card"><h3>Budget</h3><p>€450,000</p></div></div><table><thead><tr><th>Address</th><th>Status</th></tr></thead><tbody><tr><td>Calle Mayor 1</td><td><span class="badge badge-success">Viewed</span></td></tr></tbody></table>\`.

If the web-artifacts-builder skill is mounted, follow its SKILL.md design guidance, but do not run its bundling scripts: a space is an HTML fragment the host renders, not a bundled app. Author every html space on those classes, as one self-contained document with inline CSS. The host's sanitiser decides what actually renders.

Pictures: use only a picture link a search result or a page you opened in this chat returned; a plain link only from a search result. Never make one up; if you have none, leave pictures out and say so.

For a tracker (houses, tasks, candidates, or anything with several items), put one row per item in a table, with columns for what the user cares about.

There is no whole-body replacement tool: every change to an existing space goes through edit_space, which changes part of a body without resending it. Read before you edit: get_space shows the body and its revision, and list_blocks shows just the blocks, each with its anchor and a preview of its first line. Note the revision your read showed and send it as expected_revision: every edit_space call must name it, and all entries in the call apply to the blocks of that one revision. A call naming an older revision is still applied only when every block up to the one it names, and the block after it, is unchanged since your read; otherwise it is refused with the current revision and blocks, so send the change again from those. A call whose only entry is an append entry and that changes no title, purpose, status, or format is applied to the current end even when it names an older revision, because it overwrites nothing. A block entry {type: 'block', anchor, fingerprint, new_content} replaces one block's content, and empty new_content deletes the block; an insert entry {type: 'insert', after, fingerprint, new_content} adds new content right after the named block, which is how you extend a table or a list in the middle; an append entry {type: 'append', new_content} adds content at the end with no anchor or fingerprint, which is how you add rows or sections at the end. Send at most one append entry per call, and put it last. Send only rows that are not there yet: a row the table already holds is skipped, and the result names it. When a result says part of the content was not saved, continue from the line it names, without resending saved lines. End every reply that changed a space with one line saying what was saved. Every read shows each block's fingerprint: a short code hashed from the block's exact current content. An entry names the fingerprint its read showed for that block. If the block at the anchor no longer carries that fingerprint, the edit is refused and nothing is saved: when exactly one other block now carries it, the refusal names that block's anchor, because the content you meant has moved; otherwise re-read and take the anchor and fingerprint from the fresh read. Identical blocks share a fingerprint, and that is fine: the anchor still says which block you mean, and the fingerprint only checks the content. A successful edit returns the new revision and the fresh block outline: chain the next edit from those instead of re-reading. One block can be named by only one entry per call. Blocks come from the body's own structure: in a space with section markers, the anchors are the marker names; in any other space the body is split into blocks by its headings, paragraphs, list groups, and table row groups, and the anchors are b1, b2, and so on in order. Text before the first marker in a marked space is a preamble with no anchor: keep it short, and never put anything there that needs changing. An unknown or duplicate anchor fails the whole edit and the error lists the valid anchors, so re-read and address a real block instead of guessing. A marker inside a fenced code block or a <pre> or <code> element is text, not a block. edit_space can also change the space's purpose, status, or format, and rename it: pass new_title for the new name. After ${String(DELTA_BREAKER_TRIP_AFTER_FAILURES)} consecutive failed edit_space calls on one space, edit_space is refused until it is unlocked: revert_space with the space's current revision unlocks it without changing the body. Every change keeps the previous revision: to undo a bad change, call revert_space rather than rebuilding the content from memory. expected_aggregate_revision is optional: leave it out; if it is stale, the error names the current value, so retry once with it.
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
 * get_space, or a successful edit's result) showed for the block as read. Only the length
 * is bounded here: the 8-hex shape is checked in edit(), where a bad one can be refused
 * with the current outline instead of a bare validation error. A well-formed fingerprint
 * that names different content is the mismatch refusal in applyEditEntries.
 */
const SPACE_FINGERPRINT_FIELD = z.string().max(64);
const SPACE_FINGERPRINT_SHAPE = /^[0-9a-f]{8}$/;
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
/**
 * One append entry of an edit_space call: `new_content` is added after the last block of
 * the body. It names no anchor and no fingerprint because it overwrites nothing, which is
 * why an append-only call is applied to the current body even when the revision is stale.
 */
const SPACE_APPEND_EDIT_SCHEMA = z
  .object({
    type: z.literal('append'),
    new_content: z
      .string()
      .refine(text => text.trim() !== '', 'must have some text. Send the rows or lines to add at the end'),
  })
  .strict();
/** The one edit list shape: every entry names its own kind, so block, insert and append entries never mix ambiguously. */
const SPACE_EDIT_ENTRY_SCHEMA = z.discriminatedUnion('type', [
  SPACE_BLOCK_EDIT_SCHEMA,
  SPACE_INSERT_EDIT_SCHEMA,
  SPACE_APPEND_EDIT_SCHEMA,
]);
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
    edits: z
      .array(SPACE_EDIT_ENTRY_SCHEMA)
      .min(1)
      .max(50)
      .superRefine((edits, ctx) => {
        const lastIndex = edits.length - 1;
        const appendIndexes = edits.flatMap((edit, index) => (edit.type === 'append' ? [index] : []));
        if (appendIndexes.length > 1 || (appendIndexes.length === 1 && appendIndexes[0] !== lastIndex)) {
          ctx.addIssue({
            code: 'custom',
            message:
              'send at most one append entry, and put it last. To add several parts at the end, join them into one append entry',
          });
        }
      }),
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

/**
 * Thrown when a block replacement would drop a table's header or saved rows. Fail-closed policy,
 * not a delta failure: the model's copy is current, the new content is the problem.
 */
class SpaceTableRowsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpaceTableRowsRefusedError';
  }
}

function plural({ count, noun }: { count: number; noun: string }): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Refuses an edit that leaves table rows with no header above them, which breaks the table.
 * Judged on the result, so deleting a whole table or rewriting it with its header still applies.
 */
function checkNoOrphanedRows({ old_body, new_body }: { old_body: string; new_body: string }): void {
  if (orphanedRowGroupCount(new_body) <= orphanedRowGroupCount(old_body)) {
    return;
  }
  throw new SpaceTableRowsRefusedError(
    'This change would leave table rows with no header, so it would break the table. ' +
      'To add rows, use an append entry. To change these rows, send the whole block with its header.',
  );
}

/** Refuses an edit after which fewer rows with some key are saved than before, across the whole body. */
function checkSavedRowsKept({
  old_body,
  new_body,
  confirm_shrink,
}: {
  old_body: string;
  new_body: string;
  confirm_shrink: boolean | undefined;
}): void {
  if (confirm_shrink === true) {
    return;
  }
  const newCounts = new Map<string, number>();
  for (const { key } of tableRowEntries(new_body)) {
    newCounts.set(key, (newCounts.get(key) ?? 0) + 1);
  }
  const lost: string[] = [];
  for (const { key, label } of tableRowEntries(old_body)) {
    const remaining = newCounts.get(key) ?? 0;
    if (remaining > 0) {
      newCounts.set(key, remaining - 1);
    } else {
      lost.push(label);
    }
  }
  if (lost.length === 0) {
    return;
  }
  const shown = lost.slice(0, 10).join(', ');
  const names = lost.length > 10 ? `${shown}, and ${String(lost.length - 10)} more` : shown;
  throw new SpaceTableRowsRefusedError(
    `This change would remove ${plural({ count: lost.length, noun: 'row' })} that ${lost.length === 1 ? 'is' : 'are'} saved now: ${names}. ` +
      'To add rows, use an append entry. To fix a name, send the row with its new name and confirm_shrink: true. ' +
      'If you really mean to remove these rows, send the call again with confirm_shrink: true.',
  );
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
 * `/api/v1/spaces` routes and the UI do. Folders are a UI-only filing choice, so the model never
 * sees `folder_id`.
 */
const SPACE_RESULT_SCHEMA = SpaceSchema.omit({ folder_id: true }).strip();
const SPACE_SUMMARY_SCHEMA = SpaceSchema.omit({ body: true, folder_id: true }).strip();

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
  blocks?: BlockOutlineEntry[];
  /** Set when an over-size write saved only its leading lines; says where to continue. */
  partial?: WritePrefix & {
    continue_after: { anchor: string; fingerprint: string } | null;
    /** True when the saved text ends in the body's last block, so the rest can simply be appended. */
    at_end: boolean;
  };
  /**
   * Set when the call named an older revision and was applied to the current one: an
   * append-only call always is, any other call only when its blocks were proven unchanged.
   */
  stale?: { sent_revision: number; current_revision: number; append_only: boolean };
  /** Set when appended table rows start a new table with no header row. */
  starts_new_table?: true;
  /** Set when an append that named an older revision was already at the end: nothing was written. */
  already_at_end?: true;
  /** Table rows the write left out because the table already held them; set only when some were. */
  skipped_rows?: SkippedRow[];
  /** Links and pictures taken out because this chat never saw their address; set only when some were. */
  left_out?: Pick<DroppedLinks, 'links' | 'pictures'>;
}

function leftOutSentence({ links, pictures }: Pick<DroppedLinks, 'links' | 'pictures'>): string {
  const parts = [
    ...(links > 0 ? [plural({ count: links, noun: 'link' })] : []),
    ...(pictures > 0 ? [plural({ count: pictures, noun: 'picture' })] : []),
  ];
  return `Left out ${parts.join(' and ')} that did not come from this chat's searches or opened pages. Tell the person.`;
}

/**
 * The link to a space in the app: the Spaces view route for that space. The result carries
 * the name and this link, never a bare id: the model links the name when it mentions the
 * space, so a reply shows the name, not an id.
 */
function spaceLink(space_id: string): string {
  return `/spaces/${encodeURIComponent(space_id)}`;
}

function staleNote(input: { stale: WriteOutcome['stale']; saved_revision: number }): string {
  const { stale } = input;
  if (stale === undefined) {
    return '';
  }
  const current = String(stale.current_revision);
  return stale.append_only
    ? ` The space had moved to revision ${current}; the content was appended to the current end.`
    : ` Your expected_revision was ${String(stale.sent_revision)} but the space was at ${current}; every block you named still held what you read, so the change was applied to revision ${current} and saved as revision ${String(input.saved_revision)}.`;
}

/**
 * The write result. `summary` is the first key, so the model reads the name and revision
 * before anything else. The space object carries the name and link but no id: a model that
 * never sees an id cannot show one to the person. Later calls address the space by its exact
 * name (space_name), which is unique among the person's spaces.
 */
function mutationResultText(result: SpaceMutationResult, outcome: Omit<WriteOutcome, 'mutation'>): string {
  const { name, revision } = result.record;
  const lead = `${outcome.action} space "${name}" (revision ${String(revision)})`;
  const { partial } = outcome;
  const saved =
    partial === undefined
      ? `${lead}.`
      : outcome.action === 'Created'
        ? `${lead} with the first ${String(partial.saved_lines)} lines of the content. One write holds ${SPACE_WRITE_SIZE_TEXT}, so the ${String(partial.unsaved_lines)} lines from "${partial.unsaved_from}" on were not saved. Add them with an append entry, starting at that line. Do not resend the saved lines.`
        : `${lead} with the first ${String(partial.saved_lines)} lines of the new content; the ${String(partial.unsaved_lines)} lines from "${partial.unsaved_from}" on were not saved. ${
            partial.at_end || partial.continue_after === null
              ? 'Append them next.'
              : `Insert them after block ${partial.continue_after.anchor} next.`
          } Do not resend the saved lines.`;
  const summary = outcome.already_at_end
    ? `Space "${name}" is at revision ${String(revision)}. That content is already at the end of the space, so nothing was added.`
    : saved +
      staleNote({ stale: outcome.stale, saved_revision: revision }) +
      (outcome.starts_new_table === true
        ? ' The appended rows start a new table without a header row; add a header if they belong to a new table.'
        : '') +
      (outcome.skipped_rows === undefined ? '' : ` ${skippedRowsSentence(outcome.skipped_rows)}`) +
      (outcome.left_out === undefined ? '' : ` ${leftOutSentence(outcome.left_out)}`);
  return JSON.stringify({
    summary,
    ...(outcome.stale === undefined ? {} : { revision_was_stale: true }),
    ...(outcome.already_at_end === true ? { [SPACE_WRITE_NOTHING_SAVED_FIELD]: true } : {}),
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
    ...(outcome.skipped_rows === undefined ? {} : { skipped_rows: outcome.skipped_rows }),
    ...(partial === undefined
      ? {}
      : {
          saved_lines: partial.saved_lines,
          unsaved_lines: partial.unsaved_lines,
          unsaved_from: partial.unsaved_from,
          continue_after: partial.continue_after,
        }),
    format_notes: spaceFormatNotes({ body: result.record.body, format: result.record.format }),
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
  /** Plain sentences about how the body renders; empty when it is clean. */
  format_notes: string[];
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
  const isRowAt = (index: number): boolean => isTableRow(maskedLines[index] ?? '');
  const isSeparatorRow = (index: number): boolean => isTableSeparatorRow(maskedLines[index] ?? '');

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
      if (!isRowAt(index)) {
        let end = index;
        while (end < run.last && !isRowAt(end)) {
          end += 1;
        }
        pieces.push({ first: index, last: end });
        index = end;
        continue;
      }
      let regionEnd = index;
      while (regionEnd < run.last && isRowAt(regionEnd)) {
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

function lastLineOf(text: string): string {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? '').trim() !== '') {
      return lines[index] ?? '';
    }
  }
  return '';
}

function firstLineOf(text: string): string {
  for (const line of text.split('\n')) {
    if (line.trim() !== '') {
      return line;
    }
  }
  return '';
}

/**
 * The one join rule for content added after existing text, shared by insert and append.
 * A table row after a table row continues the table with one line break. Anything else
 * after a table row needs a blank line, or it would read as one more row. Otherwise the
 * existing separator is kept, and with none a structural block gets a blank line and a
 * marked block one line break.
 */
function joinGap(input: { before: string; content: string; existing: string; marked: boolean }): string {
  const tableBefore = isTableRow(lastLineOf(input.before));
  if (tableBefore && isTableRow(firstLineOf(input.content))) {
    return '\n';
  }
  const blankLine = '\n\n';
  if (input.existing !== '') {
    return tableBefore && input.existing.split('\n').length < 3 ? blankLine : input.existing;
  }
  return input.marked && !tableBefore ? '\n' : blankLine;
}

/** True when the content opens with a table row and a separator row: it brings its own header. */
function opensWithTableHeader(content: string): boolean {
  const lines = content.split('\n').filter(line => line.trim() !== '');
  return isTableRow(lines[0] ?? '') && isTableSeparatorRow(lines[1] ?? '');
}

/**
 * Drops the rows of `content` that the table ending `before` already holds, so a model
 * resending saved rows does not duplicate them. Null when the content does not continue a
 * table, or the table sits in a code fence.
 */
function dropRowsAlreadyInTable(input: { before: string; content: string }): {
  content: string;
  skipped: SkippedRow[];
} | null {
  const before = input.before.trimEnd();
  if (!isTableRow(lastLineOf(before)) || !isTableRow(firstLineOf(input.content))) {
    return null;
  }
  const existingKeys = keysOfTableEndingAt(before);
  return existingKeys === null ? null : dropDuplicateRows({ content: input.content, existingKeys });
}

/**
 * Applies one edit_space call's entries, all against the segmentation of the body the
 * call names (the current body at the revision it checked): entries never see each
 * other's results, and one block can be named by only one entry. Unknown or duplicated
 * anchors, and a fingerprint that does not match the block at its anchor, fail closed
 * before anything is persisted, and the resulting length is
 * checked arithmetically before the new body is built, mirroring the other edit paths.
 */
function applyEditEntries(input: {
  space_id: string;
  body: string;
  format: SpaceRecord['format'];
  edits: readonly SpaceEditEntry[];
  confirm_shrink: boolean | undefined;
}): {
  body: string;
  block_results: { anchor: string; new_length: number; deleted: boolean }[];
  /** An appended table row followed text that is not a table and brought no header row. */
  starts_new_table: boolean;
  skipped_rows: SkippedRow[];
  /** New content the call writes, counted after duplicate rows are dropped. */
  new_content_length: number;
} {
  const { space_id, body, format, edits, confirm_shrink } = input;
  // Markdown only: an html body has no pipe tables to compare.
  const dropSavedRows = (before: string, content: string): { content: string; skipped: SkippedRow[] } =>
    (format === 'markdown' ? dropRowsAlreadyInTable({ before, content }) : null) ?? { content, skipped: [] };
  let appended: string | undefined;
  const { preamble, segments } = segmentSpaceBody(body);
  const validAnchors = uniqueBlockAnchors(segments);
  const replacements = new Map<SpaceSegment, string>();
  const deletions = new Set<SpaceSegment>();
  const inserts = new Map<SpaceSegment, string>();
  const namedAt = new Map<string, number>();
  const block_results: { anchor: string; new_length: number; deleted: boolean }[] = [];
  const skipped_rows: SkippedRow[] = [];
  let new_content_length = 0;
  for (const [index, entry] of edits.entries()) {
    if (entry.type === 'append') {
      appended = entry.new_content;
      continue;
    }
    const anchor = (entry.type === 'block' ? entry.anchor : entry.after).trim();
    const firstNamedAt = namedAt.get(anchor);
    if (firstNamedAt !== undefined) {
      throw new SpaceBlockAnchorRepeatedError({ space_id, anchor, index, firstIndex: firstNamedAt, validAnchors });
    }
    namedAt.set(anchor, index);
    const matches = anchorMatches(segments, anchor);
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
    const targetFingerprint = segmentFingerprint(body, target);
    if (entry.fingerprint !== targetFingerprint) {
      const matchAnchors = segments
        .filter(segment => segment !== target && segmentFingerprint(body, segment) === entry.fingerprint)
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
      new_content_length += entry.new_content.length;
      if (entry.new_content === '') {
        deletions.add(target);
        block_results.push({ anchor, new_length: 0, deleted: true });
      } else {
        replacements.set(target, entry.new_content);
        const leadLength = target.marked ? markedLeadSeparator(body, target).length : 0;
        block_results.push({ anchor, new_length: leadLength + entry.new_content.length, deleted: false });
      }
    } else {
      const added = dropSavedRows(body.slice(0, target.coreEnd), entry.new_content);
      skipped_rows.push(...added.skipped);
      new_content_length += added.content.length;
      // An insert whose rows were all saved already adds nothing; the call may still carry other entries.
      if (added.content.trim() !== '') {
        inserts.set(target, added.content);
        block_results.push({ anchor, new_length: added.content.length, deleted: false });
      }
    }
  }

  // The text an insert entry adds after its block, placed between the block's content
  // and its trailing separator, so what follows the block keeps its distance.
  const insertText = (segment: SpaceSegment, content: string): string =>
    joinGap({
      before: body.slice(segment.coreStart, segment.coreEnd),
      content,
      existing: segmentTrailingSeparator(body, segment),
      marked: segment.marked,
    }) + content;
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
  let result = parts.join('');
  // Judged before any append: rows an append adds after text are reported, not refused.
  if (replacements.size > 0 || deletions.size > 0) {
    checkNoOrphanedRows({ old_body: body, new_body: result });
    checkSavedRowsKept({ old_body: body, new_body: result, confirm_shrink });
  }
  let starts_new_table = false;
  const added = appended === undefined ? undefined : dropSavedRows(result, appended);
  skipped_rows.push(...(added?.skipped ?? []));
  appended = added?.content.trim() === '' ? undefined : added?.content;
  new_content_length += appended?.length ?? 0;
  if (appended !== undefined) {
    const joined = appendAfterBody({ body: result, content: appended, marked: segments[0]?.marked === true });
    result = joined.body;
    if (result.length > SPACE_BODY_MAX_LENGTH) {
      throw new SpaceBodyTooLongError({ space_id, new_length: result.length });
    }
    starts_new_table =
      isTableRow(firstLineOf(appended)) && !isTableRow(lastLineOf(joined.before)) && !opensWithTableHeader(appended);
    // The block the new content landed in: the last block that starts at or before it.
    const landed = segmentSpaceBody(result)
      .segments.filter(segment => segment.start <= joined.contentStart)
      .at(-1);
    if (landed !== undefined) {
      block_results.push({ anchor: landed.anchor, new_length: appended.length, deleted: false });
    }
  }
  if (skipped_rows.length > 0 && block_results.length === 0) {
    throw new SpaceDuplicateRowsError();
  }
  return { body: result, block_results, starts_new_table, skipped_rows, new_content_length };
}

/** Adds content after the end of a body, keeping any longer gap the body already ends with. */
function appendAfterBody(input: { body: string; content: string; marked: boolean }): {
  body: string;
  before: string;
  contentStart: number;
} {
  const { body, content, marked } = input;
  const before = body.trimEnd();
  const trailing = body.slice(before.length);
  // A gap too short to separate the new content from the last line is replaced by the rule's own.
  const existing = trailing.split('\n').length >= (marked ? 2 : 3) ? trailing : '';
  const gap = joinGap({ before, content, existing, marked });
  if (gap === '\n') {
    return { body: `${before}\n${content}${trailing}`, before, contentStart: before.length + 1 };
  }
  return { body: before + gap + content, before, contentStart: before.length + gap.length };
}

/**
 * True when the body already ends with the content as whole lines: a match that starts
 * inside a line ("Status: all done" against "done") is not the same content.
 */
function endsWithLines(input: { body: string; content: string }): boolean {
  const end = input.body.trimEnd();
  const tail = input.content.trim();
  if (tail === '' || !end.endsWith(tail)) {
    return false;
  }
  return /(^|\n)[ \t]*$/.test(end.slice(0, end.length - tail.length));
}

/** A block this short is a placeholder, so replacing it loses nothing worth keeping. */
const PLACEHOLDER_BLOCK_MAX_LENGTH = 200;

/**
 * The leading lines of an over-size lone entry that can be saved, or null when the call
 * must be refused whole: html, a block entry over real content, or no useful prefix.
 */
function salvageableEditContent(input: {
  entry: SpaceEditEntry;
  current: SpaceRecord;
  format: SpaceRecord['format'];
}): WritePrefix | null {
  const { entry, current, format } = input;
  if (format !== 'markdown') {
    return null;
  }
  if (entry.type === 'block') {
    const target = segmentSpaceBody(current.body).segments.find(segment => segment.anchor === entry.anchor.trim());
    const isPlaceholder = target !== undefined && target.coreEnd - target.coreStart <= PLACEHOLDER_BLOCK_MAX_LENGTH;
    if (!isPlaceholder) {
      return null;
    }
  }
  return prefixWithinCap({ content: entry.new_content, cap: SPACE_WRITE_GUIDANCE_MAX_LENGTH });
}

/**
 * The block of the new body that holds the last saved character of a lone entry, so the
 * model continues right after the saved text and not after the body's last block. The
 * text after the entry's block is kept as it was, so the saved text ends that far from
 * the end of the new body.
 */
function savedTextEndBlock(input: { before: string; after: string; entry: SpaceEditEntry }): {
  ref: { anchor: string; fingerprint: string };
  at_end: boolean;
} | null {
  const { before, after, entry } = input;
  const { segments } = segmentSpaceBody(after);
  if (entry.type === 'append') {
    // An append's saved text always ends the new body.
    const last = segments.at(-1);
    return last === undefined
      ? null
      : {
          ref: { anchor: last.anchor, fingerprint: blockFingerprint(after.slice(last.coreStart, last.coreEnd)) },
          at_end: true,
        };
  }
  const anchor = (entry.type === 'block' ? entry.anchor : entry.after).trim();
  const target = segmentSpaceBody(before).segments.find(segment => segment.anchor === anchor);
  if (target === undefined) {
    return null;
  }
  const keptFrom = !target.marked
    ? target.coreEnd
    : entry.type === 'block'
      ? target.end
      : target.end - segmentTrailingSeparator(before, target).length;
  const lastSavedChar = Math.max(0, after.length - (before.length - keptFrom) - 1);
  const holder = segments.find(segment => lastSavedChar >= segment.start && lastSavedChar < segment.end);
  if (holder === undefined) {
    return null;
  }
  return {
    ref: { anchor: holder.anchor, fingerprint: blockFingerprint(after.slice(holder.coreStart, holder.coreEnd)) },
    at_end: holder === segments[segments.length - 1],
  };
}

function lastBlockRef(blocks: readonly { anchor: string; fingerprint: string }[]): {
  anchor: string;
  fingerprint: string;
} | null {
  const last = blocks[blocks.length - 1];
  return last === undefined ? null : { anchor: last.anchor, fingerprint: last.fingerprint };
}

/** The blocks an anchor names in one segmentation: one for a usable anchor, none or several otherwise. */
function anchorMatches(segments: readonly SpaceSegment[], anchor: string): SpaceSegment[] {
  return segments.filter(segment => segment.anchor === anchor);
}

function segmentFingerprint(body: string, segment: SpaceSegment): string {
  return blockFingerprint(body.slice(segment.coreStart, segment.coreEnd));
}

/**
 * Whether a call written against `readBody` (the revision it named) can be applied to
 * `currentBody` without landing somewhere else. Per entry: the anchor resolves in the
 * read body and its block carries the named fingerprint there; every block from the
 * start through the anchor is the same in both bodies, so an ordinal anchor and a
 * repeated fingerprint mean the same block; and the block after the anchor is the same
 * too when the entry inserts or the anchor is a marker, so an insert lands in the same
 * place and a repeated insert is caught. An append entry needs the same last block.
 */
function staleEditStillApplies(input: {
  readBody: string;
  currentBody: string;
  edits: readonly SpaceEditEntry[];
}): boolean {
  const read = segmentSpaceBody(input.readBody);
  const current = segmentSpaceBody(input.currentBody);
  if (read.preamble !== current.preamble) {
    return false;
  }
  const sameBlock = (index: number): boolean => {
    const before = read.segments[index];
    const now = current.segments[index];
    if (before === undefined || now === undefined) {
      return before === undefined && now === undefined;
    }
    return (
      before.anchor === now.anchor &&
      segmentFingerprint(input.readBody, before) === segmentFingerprint(input.currentBody, now)
    );
  };
  return input.edits.every(entry => {
    if (entry.type === 'append') {
      // The end must not have moved, or the content would land after text the model never read.
      return read.segments.length === current.segments.length && sameBlock(read.segments.length - 1);
    }
    const anchor = (entry.type === 'block' ? entry.anchor : entry.after).trim();
    const matches = anchorMatches(read.segments, anchor);
    const [target] = matches;
    if (
      target === undefined ||
      matches.length > 1 ||
      segmentFingerprint(input.readBody, target) !== entry.fingerprint
    ) {
      return false;
    }
    const at = read.segments.indexOf(target);
    for (let index = 0; index <= at; index += 1) {
      if (!sameBlock(index)) {
        return false;
      }
    }
    return entry.type === 'block' && !target.marked ? true : sameBlock(at + 1);
  });
}

interface BlockOutlineEntry {
  anchor: string;
  fingerprint: string;
  preview: string;
  occurrences: number;
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
  blocks: BlockOutlineEntry[];
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
        "Create a persistent space: a named page the host renders in the Spaces view. Write and change a space only with create_space and edit_space, never by editing files in the sandbox. The name must be one no existing space has: a taken name is refused, so change the existing space with edit_space instead. Use format 'markdown' for a list or note, and 'html' for a page meant to be looked at. An html body is one complete fragment with no <script>, external stylesheets, or external fonts (the host strips all three). Scripts never run on a space page, so use plain HTML and CSS. Pictures come from a page you opened or a search result. Pass body as one string with real line breaks, at most " +
        SPACE_WRITE_SIZE_TEXT +
        "; add the rest afterwards with edit_space. Mark updatable sections with <!-- @block:name --> markers. The result gives the new space's name and link; mention the space by linking its name, never by an id.",
      schema: CREATE_SPACE_INPUT_SCHEMA,
      invalidInput: spaceInvalidInput,
      handler: async input => this.write(() => this.create(input)),
    }),
    defineTool({
      name: EDIT_SPACE_TOOL_NAME,
      description:
        'Change part of one space by its exact space_name, without resending the body. ' +
        'Read the space first (get_space, or list_blocks for just its blocks) and send expected_revision set to the revision that read showed: every entry addresses a block of that one revision. ' +
        'A call naming an older revision is applied only when every block up to the one it names, and the block after it, is unchanged since that read; otherwise it is refused with the current revision and blocks. ' +
        'A call that only appends and changes no title, purpose, status, or format is applied to the current end. ' +
        'edits is a list of up to 50 entries: a block entry {type: "block", anchor, fingerprint, new_content} replaces the content of the block the anchor names, and empty new_content deletes it; an insert entry {type: "insert", after, fingerprint, new_content} adds new content right after the named block; an append entry {type: "append", new_content} adds content at the end of the space with no anchor or fingerprint: the way to add rows or sections. Send at most one append entry per call, and put it last. One block can be named by only one entry per call. ' +
        "fingerprint is the block's fingerprint as that read showed it: a short code hashed from the block's exact current content. An entry whose fingerprint does not match the block at its anchor is refused and nothing is saved; when exactly one other block now carries that fingerprint, the refusal names that block's anchor. " +
        'Anchors come from list_blocks: the name of a <!-- @block:name --> section, or b1, b2, and so on for the blocks a body without markers is split into. ' +
        'An unknown or duplicate anchor fails the whole edit and nothing is saved: do not retry the same entry. Re-read the space and correct the entry from the fresh read. ' +
        'The new content across one call may total at most ' +
        SPACE_WRITE_SIZE_TEXT +
        '; split a bigger change into several calls. ' +
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
    // The link check is a safety check on the content, so it runs before the size policy:
    // a write that breaks both rules gets the safety refusal. Unseen links are cut out here.
    const checkLinks = (candidate: string): DroppedLinks =>
      dropUnseenSpaceLinks({
        body: candidate,
        previousBody: '',
        format: input.format,
        web_search: this.options.webSearch,
      });
    checkLinks(input.body);
    // Dropping repeated rows first lets a call that only overshoots because of them still fit.
    const deduped =
      input.format === 'markdown'
        ? dropDuplicateRows({ content: input.body, existingKeys: [] })
        : { content: input.body, skipped: [] };
    let body = deduped.content;
    let cut: WritePrefix | null = null;
    if (body.length > SPACE_WRITE_MAX_LENGTH) {
      // Markdown only: a cut html page would be left with unclosed tags.
      cut =
        input.format === 'markdown' ? prefixWithinCap({ content: body, cap: SPACE_WRITE_GUIDANCE_MAX_LENGTH }) : null;
      if (cut === null) {
        throw new SpaceWriteTooLongError({
          tool: CREATE_SPACE_TOOL_NAME,
          space_id: null,
          new_length: body.length,
        });
      }
      body = cut.kept;
    }
    // The cut and the duplicate drop can change how the text reads (a code span can lose its
    // closing line), so what is saved is checked again; its counts are what was left out.
    const checked = checkLinks(body);
    body = checked.body;
    if (body.trim() === '') {
      throw new SpaceBodyEmptyError({ space_id: '' });
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
      body,
      format: input.format,
      expected_aggregate_revision,
    });
    // The outline lets the next edit chain from real anchors and fingerprints.
    const blocks = blockOutline(mutation.record.body).blocks;
    const skipped_rows = cut === null ? deduped.skipped : skippedRowsWithin({ content: input.body, kept: cut.kept });
    return {
      mutation,
      action: 'Created',
      blocks,
      ...(cut === null ? {} : { partial: { ...cut, continue_after: lastBlockRef(blocks), at_end: true } }),
      ...(skipped_rows.length === 0 ? {} : { skipped_rows }),
      ...(checked.links + checked.pictures === 0
        ? {}
        : { left_out: { links: checked.links, pictures: checked.pictures } }),
    };
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
    const requested_length = input.edits.reduce((total, edit) => total + edit.new_content.length, 0);
    const over_cap = requested_length > SPACE_WRITE_MAX_LENGTH;
    // Only a single entry can be cut to a prefix, and only insert and append entries can
    // shrink once saved rows are dropped; any other over-size call is refused here, before the reads.
    const lone = input.edits.length === 1 ? input.edits[0] : undefined;
    const mayShrink = input.edits.some(edit => edit.type !== 'block');
    const tooLong = (new_length: number): SpaceWriteTooLongError =>
      new SpaceWriteTooLongError({ tool: EDIT_SPACE_TOOL_NAME, space_id: input.space_id, new_length });
    if (over_cap && lone === undefined && !mayShrink) {
      throw tooLong(requested_length);
    }
    // Refuse a locked delta before the expensive reads: the burn loop this guards against
    // would otherwise keep paying an aggregate-revision resolve plus a full-body read per
    // refusal. The name lookup above is the only store read a locked call pays.
    this.throwIfDeltaLocked(input.space_id);
    const [expected_aggregate_revision, current] = await Promise.all([
      resolveAggregateRevision(this.options.store, this.options.authority, input.expected_aggregate_revision),
      this.requireCurrentSpace(input.space_id),
    ]);
    // An over-size call never counts toward the delta breaker. One that cannot be cut and
    // could fit only after the duplicate drop is refused for its size when anything else is
    // wrong with it too: the model must shorten it, not fix a copy it cannot trust.
    let cut =
      over_cap && lone !== undefined
        ? salvageableEditContent({ entry: lone, current, format: input.format ?? current.format })
        : null;
    const refuseForSize = over_cap && cut === null;
    if (refuseForSize && !mayShrink) {
      throw tooLong(requested_length);
    }
    for (const [index, entry] of input.edits.entries()) {
      if (entry.type !== 'append' && !SPACE_FINGERPRINT_SHAPE.test(entry.fingerprint)) {
        if (refuseForSize) {
          throw tooLong(requested_length);
        }
        throw new SpaceFingerprintFormatError({
          index,
          fingerprint: entry.fingerprint,
          revision: current.revision,
          blocks: blockOutline(current.body).blocks,
        });
      }
    }
    // An append-only call overwrites nothing, so a stale revision does not refuse it: it is
    // applied to the current end. Changing the title, purpose, status or format overwrites
    // something, so such a call is not append-only.
    const appendOnly =
      input.edits.every(edit => edit.type === 'append') &&
      input.new_title === undefined &&
      input.purpose === undefined &&
      input.status === undefined &&
      input.format === undefined;
    // Any other call on a space that moved since the model's read is still safe when the
    // read revision shows every entry would land on the same block now. Anything else gets
    // the current outline back. A revision past the current one is a made-up number. The
    // store still fences the write at the revision read here.
    let stale: WriteOutcome['stale'];
    if (input.expected_revision !== current.revision) {
      // A revision past the current one was never read, so not even an append can trust it.
      if (!appendOnly || input.expected_revision > current.revision) {
        const read =
          input.expected_revision < current.revision
            ? await this.options.store.getSpaceRevision({
                tenant_id: this.options.authority.tenantId,
                created_by: this.options.authority.userRef,
                space_id: input.space_id,
                revision: input.expected_revision,
              })
            : undefined;
        if (
          read === undefined ||
          !staleEditStillApplies({ readBody: read.body, currentBody: current.body, edits: input.edits })
        ) {
          if (refuseForSize) {
            throw tooLong(requested_length);
          }
          throw new SpaceStaleRevisionError({
            expected_revision: input.expected_revision,
            actual_revision: current.revision,
            blocks: blockOutline(current.body).blocks,
          });
        }
      }
      stale = { sent_revision: input.expected_revision, current_revision: current.revision, append_only: appendOnly };
    }
    // A resend of an append the space already ends with must not add the rows a second time.
    const appendedEdit = input.edits.find(edit => edit.type === 'append');
    if (
      stale?.append_only === true &&
      appendedEdit !== undefined &&
      endsWithLines({ body: current.body, content: appendedEdit.new_content })
    ) {
      return {
        mutation: { record: current, aggregate_revision: expected_aggregate_revision },
        action: 'Updated',
        already_at_end: true,
        blocks: blockOutline(current.body).blocks,
      };
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
    const format = input.format ?? current.format;
    let applied: ReturnType<typeof applyEditEntries>;
    try {
      applied = applyEditEntries({
        space_id: input.space_id,
        body: current.body,
        format,
        edits: input.edits,
        confirm_shrink: input.confirm_shrink,
      });
    } catch (error) {
      if (error instanceof SpaceBlockAnchorError || error instanceof SpaceBodyTooLongError) {
        if (refuseForSize) {
          throw tooLong(requested_length);
        }
        if (!over_cap) {
          this.recordDeltaFailure(input.space_id);
        }
      }
      throw error;
    }
    if (applied.new_content_length <= SPACE_WRITE_MAX_LENGTH) {
      // The duplicate drop brought the call under the cap: nothing needs cutting.
      cut = null;
    } else if (cut === null) {
      throw tooLong(applied.new_content_length);
    }
    const checkLinks = (candidate: string): DroppedLinks =>
      dropUnseenSpaceLinks({
        body: candidate,
        previousBody: current.body,
        format,
        web_search: this.options.webSearch,
      });
    // Refusals for the full content come before the size cut.
    checkLinks(applied.body);
    let entries: readonly SpaceEditEntry[] = input.edits;
    if (cut !== null && lone !== undefined) {
      entries = [{ ...lone, new_content: cut.kept }];
      applied = applyEditEntries({
        space_id: input.space_id,
        body: current.body,
        format,
        edits: entries,
        confirm_shrink: input.confirm_shrink,
      });
    }
    // What is saved is cleaned entry by entry and applied again, so block lengths and the counts
    // describe the saved text only, and the last check below is the safety net for the whole body.
    let checked = checkLinks(applied.body);
    if (checked.links + checked.pictures > 0) {
      const counts = { links: 0, pictures: 0 };
      const cleaned = entries.map(entry => {
        const dropped = checkLinks(entry.new_content);
        if (dropped.body.trim() === '' && entry.new_content.trim() !== '') {
          throw new SpaceLinkRefusedError(
            'Nothing was left of this content after links and pictures that did not come from this chat were left out. Add text, then send the call again.',
          );
        }
        counts.links += dropped.links;
        counts.pictures += dropped.pictures;
        return { ...entry, new_content: dropped.body };
      });
      applied = applyEditEntries({
        space_id: input.space_id,
        body: current.body,
        format,
        edits: cleaned,
        confirm_shrink: input.confirm_shrink,
      });
      const last = checkLinks(applied.body);
      checked = { body: last.body, links: counts.links + last.links, pictures: counts.pictures + last.pictures };
    }
    const { block_results, starts_new_table, skipped_rows } = applied;
    const { body } = checked;
    // Judged on the final body, after any append and on the stale-but-proven path too. Not a
    // delta failure: the model's copy is fine, the call just does nothing.
    if (
      body === current.body &&
      (input.new_title ?? current.name) === current.name &&
      (input.purpose ?? current.purpose) === current.purpose &&
      (input.status ?? current.status) === current.status &&
      format === current.format
    ) {
      throw new SpaceEditUnchangedError(
        checked.links + checked.pictures > 0 ? { links: checked.links, pictures: checked.pictures } : undefined,
      );
    }
    this.checkShrink(input.space_id, current, body, input.confirm_shrink, EDIT_SPACE_TOOL_NAME);
    if (body.length === 0) {
      throw new SpaceBodyEmptyError({ space_id: input.space_id });
    }
    let mutation: SpaceMutationResult;
    try {
      mutation = await this.options.store.updateSpace({
        tenant_id: this.options.authority.tenantId,
        created_by: this.options.authority.userRef,
        space_id: input.space_id,
        // On the edit path, omitted metadata means "unchanged": fall back to current values.
        name: input.new_title ?? current.name,
        purpose: input.purpose ?? current.purpose,
        status: input.status ?? current.status,
        body,
        format: input.format ?? current.format,
        expected_revision: current.revision,
        expected_aggregate_revision,
      });
    } catch (error) {
      if (!(error instanceof SpaceRevisionConflictError)) {
        throw error;
      }
      // Another writer got in after the read: hand back what is there now, not a bare refusal.
      const latest = await this.requireCurrentSpace(input.space_id);
      throw new SpaceStaleRevisionError({
        expected_revision: input.expected_revision,
        actual_revision: latest.revision,
        blocks: blockOutline(latest.body).blocks,
        cause: error,
      });
    }
    const outcome: WriteOutcome = { mutation, action: 'Updated' };
    if (starts_new_table) {
      outcome.starts_new_table = true;
    }
    if (stale !== undefined) {
      outcome.stale = stale;
    }
    if (block_results.length > 0) {
      outcome.block_results = block_results;
    }
    if (skipped_rows.length > 0) {
      outcome.skipped_rows = skipped_rows;
    }
    if (checked.links + checked.pictures > 0) {
      outcome.left_out = { links: checked.links, pictures: checked.pictures };
    }
    // The fresh outline of the new body, at the new revision: the next edit chains
    // from these anchors instead of paying a re-read first.
    outcome.blocks = blockOutline(mutation.record.body).blocks;
    if (cut !== null) {
      const end = lone === undefined ? null : savedTextEndBlock({ before: current.body, after: body, entry: lone });
      outcome.partial = {
        ...cut,
        continue_after: end?.ref ?? lastBlockRef(outcome.blocks),
        at_end: end?.at_end ?? true,
      };
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
      format_notes: spaceFormatNotes({ body: current.body, format: current.format }),
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
      format_notes: spaceFormatNotes({ body: result.space.body, format: parsed.format }),
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
      if (error instanceof SpaceShrinkRefusedError || error instanceof SpaceTableRowsRefusedError) {
        return toolResultResponse({ text: JSON.stringify({ error: error.message }), isError: true });
      }
      if (error instanceof SpaceBodyTooLongError) {
        return toolResultResponse({ text: JSON.stringify({ error: error.message }), isError: true });
      }
      if (error instanceof SpaceDuplicateRowsError) {
        return toolResultResponse({ text: JSON.stringify({ error: error.message }), isError: true });
      }
      if (error instanceof SpaceBodyEmptyError) {
        return toolResultResponse({ text: JSON.stringify({ error: error.message }), isError: true });
      }
      if (error instanceof SpaceEditUnchangedError) {
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
      if (error instanceof SpaceFingerprintFormatError || error instanceof SpaceStaleRevisionError) {
        return toolResultResponse({
          text: JSON.stringify({ error: error.message, revision: error.revision, blocks: error.blocks }),
          isError: true,
        });
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
        ...(personas === undefined
          ? []
          : [personaCapability({ ...personas, switches: this.switches, tracing: input.tracing, sentinel })]),
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
