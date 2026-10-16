import { z } from 'zod';
import type { TokenPagination } from '../schemas/pagination';
import { decodePageToken, encodePageToken } from './PageToken';
import { InvalidPageTokenError } from './SessionStoreErrors';

/**
 * Keyset cursor for `listSessionEvents`: the branch anchor plus the last row a page returned.
 * The next page resumes strictly after that row in (chain position desc, event id desc) order,
 * so rows appended between requests never shift, repeat, or skip later pages the way an offset
 * would. Replaces offset tokens for this list only.
 */
export const SessionEventPageCursorSchema = z
  .object({
    last_turn_id: z.string().min(1),
    turn_id: z.string().min(1),
    event_id: z.string().min(1),
  })
  .strict();

export type SessionEventPageCursor = z.infer<typeof SessionEventPageCursorSchema>;

export function encodeSessionEventPageToken(cursor: SessionEventPageCursor): string {
  return encodePageToken(SessionEventPageCursorSchema, cursor);
}

export function decodeSessionEventPageToken(token: string): SessionEventPageCursor {
  return decodePageToken(SessionEventPageCursorSchema, token);
}

/**
 * Turns (oldest first) a page may still read: the whole chain for a first page, otherwise the
 * chain up to and including the cursor row's turn. Rows of that turn must additionally sort
 * below `cursor.event_id`, which each backend applies in its own query.
 */
export function sessionEventChainWindow({
  chain,
  cursor,
}: {
  chain: readonly string[];
  cursor: SessionEventPageCursor | undefined;
}): string[] {
  if (cursor === undefined) {
    return [...chain];
  }
  const position = chain.indexOf(cursor.turn_id);
  if (position === -1) {
    // A turn off the anchor's chain cannot have come from this listing.
    throw new InvalidPageTokenError(encodeSessionEventPageToken(cursor));
  }
  return chain.slice(0, position + 1);
}

export function paginateSessionEventRows<T extends { turn_id: string; event: { id: string } }>(
  rows: T[],
  { limit, last_turn_id }: { limit: number; last_turn_id: string },
): { data: T[]; pagination: TokenPagination } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);
  return {
    data,
    pagination: {
      limit,
      ...(hasMore && last !== undefined
        ? {
            next_page_token: encodeSessionEventPageToken({
              last_turn_id,
              turn_id: last.turn_id,
              event_id: last.event.id,
            }),
          }
        : {}),
    },
  };
}
