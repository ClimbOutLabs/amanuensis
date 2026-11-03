import { OpenAPIHono } from '@hono/zod-openapi';
import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import { rawSandboxId, type SandboxWorkspace, type SandboxWorkspaceSlot } from '@truefoundry/trueforge-core/core';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { listSandboxWorkspacesRoute } from '../routes/sandboxWorkspaceRoutes';
import type { SlotWorkspaceSessions } from '../sandbox/slotBackend';
import { sandboxIdOfLastTurn } from './sessions';

export interface SandboxWorkspacesRouterDeps {
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'listSessions' | 'getTurn'>;
  logger: Logger;
  resolveRequestContext: ResolveRequestContext;
  /** Every slot's workspace sessions; empty when the slots backend is off. Throws when a slot cannot be asked. */
  listSlotWorkspaces: () => Promise<SlotWorkspaceSessions[]>;
}

/** Sessions per page while walking the tenant's chats to join them to their workspaces. */
const SESSION_PAGE_LIMIT = 200;

/** Admin/settings chat-workspace surface (mounted at /api/v1/settings/sandbox-workspaces). */
export function createSandboxWorkspacesRouter(deps: SandboxWorkspacesRouterDeps) {
  const router = new OpenAPIHono();
  router.openapi(listSandboxWorkspacesRoute, async c => {
    const requestContext = deps.resolveRequestContext(c);
    let slotListings: SlotWorkspaceSessions[];
    try {
      slotListings = await deps.listSlotWorkspaces();
    } catch (error) {
      throw new HTTPException(500, {
        message:
          'The sandbox slots could not be asked, so the chat workspaces are not listed. Run `aman doctor sandbox` on the machine this app runs on, then try again.',
        cause: error,
      });
    }

    // Join key: the sandbox id a chat's last turn recorded for its workspace, in its raw form.
    const chatBySandboxId = new Map<string, { chatId: string; title: string | null }>();
    if (slotListings.length > 0) {
      let pageToken: string | undefined;
      do {
        const page = await deps.sessionStore.listSessions({
          tenant_id: requestContext.tenant_id,
          limit: SESSION_PAGE_LIMIT,
          page_token: pageToken,
          order: undefined,
          start_timestamp: undefined,
          end_timestamp: undefined,
          agent_id: undefined,
          folder_id: undefined,
          no_folder: false,
          created_by_or_agent_ids: undefined,
          metadata: undefined,
          source_type: undefined,
          source_id: undefined,
        });
        for (const record of page.data) {
          const sandboxId = await sandboxIdOfLastTurn({
            deps: { sessionStore: deps.sessionStore, logger: deps.logger },
            record,
          });
          if (sandboxId !== undefined) {
            chatBySandboxId.set(rawSandboxId(sandboxId), { chatId: record.session_id, title: record.title });
          }
        }
        pageToken = page.pagination.next_page_token;
      } while (pageToken !== undefined);
    }

    const workspaces: SandboxWorkspace[] = [];
    const slots: SandboxWorkspaceSlot[] = [];
    for (const slotListing of slotListings) {
      let totalBytes = 0;
      for (const session of slotListing.sessions) {
        totalBytes += session.bytes;
        const sandboxId = `s${String(slotListing.slot)}-${session.session_id}`;
        const chat = chatBySandboxId.get(sandboxId);
        workspaces.push({
          chat_id: chat?.chatId ?? null,
          chat_title: chat?.title ?? null,
          sandbox_id: sandboxId,
          slot: slotListing.slot,
          bytes: session.bytes,
          entries: session.entries,
          last_used: session.last_used,
        });
      }
      slots.push({
        slot: slotListing.slot,
        workspace_count: slotListing.sessions.length,
        total_bytes: totalBytes,
        store_free_bytes: slotListing.storeFreeBytes,
      });
    }
    // Slot order first, then most recently used first, so the list is steady between reads.
    workspaces.sort((a, b) => a.slot - b.slot || b.last_used.localeCompare(a.last_used));
    return c.json({ data: { slots, workspaces } }, 200);
  });
  return router;
}
