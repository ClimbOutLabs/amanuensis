import { OpenAPIHono } from '@hono/zod-openapi';
import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import {
  formatSandboxId,
  rawSandboxId,
  type SandboxWorkspace,
  type SandboxWorkspaceSlot,
} from '@truefoundry/trueforge-core/core';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { listSandboxWorkspacesRoute } from '../routes/sandboxWorkspaceRoutes';
import type { SlotWorkspaceSessions } from '../sandbox/slotBackend';

/** The provider type slot sandboxes record in a versioned sandbox id. */
const SLOTS_PROVIDER_TYPE = 'slots';

export interface SandboxWorkspacesRouterDeps {
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'findChatsBySandboxIds'>;
  logger: Logger;
  resolveRequestContext: ResolveRequestContext;
  /** Every slot's workspace sessions; empty when the slots backend is off. Throws when a slot cannot be asked. */
  listSlotWorkspaces: () => Promise<SlotWorkspaceSessions[]>;
}

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

    // Join key: the sandbox id a chat's latest turn recorded, which may be the raw slot id or its versioned form.
    const reported = slotListings.flatMap(slotListing =>
      slotListing.sessions.map(session => `s${String(slotListing.slot)}-${session.session_id}`),
    );
    const chats = await deps.sessionStore.findChatsBySandboxIds({
      tenant_id: requestContext.tenant_id,
      sandbox_ids: reported.flatMap(raw => [raw, formatSandboxId({ providerType: SLOTS_PROVIDER_TYPE, rawId: raw })]),
    });
    const chatBySandboxId = new Map(chats.map(chat => [rawSandboxId(chat.sandbox_id), chat]));

    const workspaces: SandboxWorkspace[] = [];
    const slots: SandboxWorkspaceSlot[] = [];
    for (const slotListing of slotListings) {
      let totalBytes = 0;
      for (const session of slotListing.sessions) {
        totalBytes += session.bytes;
        const sandboxId = `s${String(slotListing.slot)}-${session.session_id}`;
        const chat = chatBySandboxId.get(sandboxId);
        // Another person's chat is named only as theirs: its title is theirs to see.
        const yours = chat?.created_by_subject_id === requestContext.subject.id;
        // A private chat stays out of every list by title, even for its owner.
        const yourPrivate = yours && chat.is_private;
        workspaces.push({
          holder: chat === undefined ? 'none' : yours ? 'you' : 'someone_else',
          chat_id: yours ? chat.session_id : null,
          chat_title: yours && !chat.is_private ? chat.title : null,
          chat_private: yourPrivate,
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
