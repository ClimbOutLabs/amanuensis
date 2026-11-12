/**
 * What a Drive write will do, settled once from the call: what the owner is shown on the card, and the hash
 * that binds the two, so an approval runs only the write that was on the card.
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '../permissions/approvalTokens';
import type { DriveFile } from './driveWire';
import type { CreateDocInput } from './toolContract';

/**
 * A Drive write as the owner is shown it. Text is raw; the card escapes it. A create carries its title and
 * whole text; an append carries the spreadsheet's name, the tab, and every row exactly as it will be sent.
 */
export interface DriveWriteReview {
  action: 'create_doc' | 'append_rows';
  /** The Google account whose Drive is written. */
  account: string;
  /** The Doc's title for a create; the spreadsheet's name for an append. */
  file_name: string;
  /** The tab an append adds to; null for a create. */
  sheet_name: string | null;
  /** The whole text a create writes; empty for an append. */
  text: string;
  /** The rows an append adds, in order; empty for a create. */
  rows: string[][];
  /**
   * How many other people the file is shared with, not counting its owner. Zero for a create, whose file
   * does not exist yet, and for a file shared with nobody. Null when the file is shared but Google did
   * not list who with, so the card can still say it is shared without naming a wrong number.
   */
  shared_with: number | null;
}

/** How many people a file is shared with besides its owner, read off the file as Google holds it. */
export function sharedWithCount(file: DriveFile): number | null {
  if (file.permissions !== undefined) {
    return file.permissions.filter(permission => permission.role !== 'owner').length;
  }
  return file.shared === true ? null : 0;
}

/** The append as it will be sent, settled from the call and the spreadsheet as Google holds it. */
export interface AppendWriteRequest {
  file_id: string;
  sheet_title: string;
  rows: string[][];
}

export function reviewForCreate(input: { call: CreateDocInput; account: string }): DriveWriteReview {
  return {
    action: 'create_doc',
    account: input.account,
    file_name: input.call.title,
    sheet_name: null,
    text: input.call.text,
    rows: [],
    shared_with: 0,
  };
}

export function reviewForAppend(input: {
  account: string;
  file_name: string;
  request: AppendWriteRequest;
  shared_with: number | null;
}): DriveWriteReview {
  return {
    action: 'append_rows',
    account: input.account,
    file_name: input.file_name,
    sheet_name: input.request.sheet_title,
    text: '',
    rows: input.request.rows,
    shared_with: input.shared_with,
  };
}

/** The write an approval is bound to: the whole content for a create, the target and rows for an append. */
export function hashDriveWrite(input: {
  tool_name: string;
  title: string | undefined;
  text: string | undefined;
  request: AppendWriteRequest | undefined;
}): string {
  return createHash('sha256')
    .update(
      stableStringify({
        tool_name: input.tool_name,
        title: input.title ?? null,
        text: input.text ?? null,
        file_id: input.request?.file_id ?? null,
        sheet_title: input.request?.sheet_title ?? null,
        rows: input.request?.rows ?? null,
      }),
    )
    .digest('hex');
}
