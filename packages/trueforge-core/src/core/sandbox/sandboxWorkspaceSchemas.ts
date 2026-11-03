import { z } from 'zod';

/**
 * One chat's sandbox workspace on a slot, as the settings listing reports it. The chat fields are
 * null when no chat holds the workspace: its chat was deleted without its workspace being removed,
 * or the workspace was never recorded against a chat.
 */
export const SandboxWorkspaceSchema = z.object({
  chat_id: z.string().nullable(),
  /** The chat's title; null when the chat has none, and when no chat holds the workspace. */
  chat_title: z.string().nullable(),
  /** The workspace's sandbox id, `s<slot>-<session id>`: the id chats record for their workspace. */
  sandbox_id: z.string(),
  /** Which slot the workspace lives on, 1-based. */
  slot: z.number().int().positive(),
  /** Space the workspace's files occupy on disk, bytes. */
  bytes: z.number().int().nonnegative(),
  /** Files and folders in the workspace. */
  entries: z.number().int().nonnegative(),
  /** When the workspace was last used, ISO 8601, as the slot agent reports it. */
  last_used: z.string(),
});
export type SandboxWorkspace = z.infer<typeof SandboxWorkspaceSchema>;

/** One slot's workspaces at a glance, with the room its workspaces can still grow into. */
export const SandboxWorkspaceSlotSchema = z.object({
  /** Which slot this summary is for, 1-based. */
  slot: z.number().int().positive(),
  workspace_count: z.number().int().nonnegative(),
  /** Space the slot's workspaces occupy together, bytes. */
  total_bytes: z.number().int().nonnegative(),
  /** Free bytes on the filesystem the slot's workspaces live on. */
  store_free_bytes: z.number().int().nonnegative(),
});
export type SandboxWorkspaceSlot = z.infer<typeof SandboxWorkspaceSlotSchema>;

/** Every chat workspace on every slot, with one summary per slot. Empty on installs without slots. */
export const SandboxWorkspaceListingSchema = z.object({
  slots: z.array(SandboxWorkspaceSlotSchema),
  workspaces: z.array(SandboxWorkspaceSchema),
});
export type SandboxWorkspaceListing = z.infer<typeof SandboxWorkspaceListingSchema>;
