/**
 * Review of older memory notes (mounted at /api/v1/memory/vault/review).
 *
 * Lists the older notes that may be marked as the person's own words and marks the ones the person
 * named.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { Context } from 'hono';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import configuration from '../config';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { listMemoryVaultReviewNotesRoute, markMemoryVaultReviewNotesRoute } from '../routes/memoryVaultRoutes';
import { sanitizeNamespace, vaultFilesystemNamespace } from '../runtime/memory/markdownMemoryFiles';
import { markReviewedNotesFromYou, type ReviewSkipReason } from '../runtime/memory/memorySourceLines';
import {
  checkReviewIds,
  findReviewCandidates,
  type ReviewRefusal,
  type ReviewScope,
} from '../runtime/memory/reviewOlderNotes';

export interface MemoryVaultReviewRouterDeps {
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
}

const REVIEW_REFUSAL_WORDS: Record<ReviewRefusal | ReviewSkipReason, string> = {
  not_found: 'This note is no longer there. Reload the list.',
  not_reviewable: 'This note does not qualify for review. Reload the list.',
  edited_or_deleted: 'You edited or deleted this note, so it stays as it is.',
  chat_unavailable: 'Its chat is gone or cannot be read, so it stays external.',
  read_outside: 'Aman read something from outside in that chat, so it stays external.',
  already_reviewed: 'This note is already marked as yours.',
};

export function createMemoryVaultReviewRouter(deps: MemoryVaultReviewRouterDeps) {
  /** The vault a review runs in, and whose chats may vouch for its notes. */
  const reviewScope = (c: Context, namespace: string | undefined): ReviewScope => {
    const requestContext = deps.resolveRequestContext(c);
    const tenantNamespace = sanitizeNamespace(requestContext.tenant_id);
    return {
      baseDir: configuration.MEMORY_MARKDOWN_DIR,
      tenantNamespace,
      vaultNamespace: sanitizeNamespace(vaultFilesystemNamespace(tenantNamespace, namespace)),
      tenantId: requestContext.tenant_id,
      subjectId: requestContext.subject.id,
      sessionStore: deps.sessionStore,
    };
  };

  const listHandler: RouteHandler<typeof listMemoryVaultReviewNotesRoute> = async c => {
    const { namespace, cursor } = c.req.valid('query');
    try {
      const found = await findReviewCandidates({
        scope: reviewScope(c, namespace),
        cursor: cursor === undefined ? 0 : Number(cursor),
        now: Date.now,
      });
      return c.json(
        {
          data: {
            notes: found.candidates.map(note => ({
              entry_id: note.entryId,
              day: note.day,
              text: note.text,
              chat_title: note.chatTitle,
            })),
            note_count: found.candidates.length,
            next_cursor: found.nextCursor === null ? null : String(found.nextCursor),
          },
        },
        200,
      );
    } catch (error) {
      deps.logger.warn('Could not list older notes to review', { error });
      return c.json({ error: { message: 'Older notes could not be listed. Try again in a moment.' } }, 500);
    }
  };

  const markHandler: RouteHandler<typeof markMemoryVaultReviewNotesRoute> = async c => {
    const body = c.req.valid('json');
    try {
      const scope = reviewScope(c, body.namespace);
      // Every id is judged again here, whatever an earlier list said.
      const checked = await checkReviewIds({ scope, entryIds: body.entry_ids });
      const recorded = await markReviewedNotesFromYou({
        baseDir: scope.baseDir,
        namespace: scope.vaultNamespace,
        entryIds: checked.allowed,
      });
      const refused = [...checked.refused, ...recorded.skipped].map(item => ({
        entry_id: item.entryId,
        reason: REVIEW_REFUSAL_WORDS[item.reason],
      }));
      return c.json({ data: { marked_count: recorded.recorded.length, marked_ids: recorded.recorded, refused } }, 200);
    } catch (error) {
      deps.logger.warn('Could not mark older notes as from you', { error });
      return c.json({ error: { message: 'The notes could not be marked. Try again in a moment.' } }, 500);
    }
  };

  const router = new OpenAPIHono();
  router.openapi(listMemoryVaultReviewNotesRoute, listHandler);
  router.openapi(markMemoryVaultReviewNotesRoute, markHandler);
  return router;
}
