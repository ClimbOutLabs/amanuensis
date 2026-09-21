// Default normal-mode key bindings. `keymapOverrides` from
// ~/.gmail-mcp/config.json (Phase D Session 3) merges on top.
//
// Bindings are grouped into categories so the help modal can render them
// section-by-section. The single-char vim conventions (h/j/k/l, gg/G, Tab,
// q/Q) are preserved; everything else is additive — vim-inspired motion
// (Ctrl-d/u/f/b, H/M/L), g-prefix folder jumps (gi/gs/gd/…), and Gmail
// actions that were previously command-palette-only (a archive, f forward,
// t add-label, ! spam, y copy-id).

export type KeyCategory = "Movement" | "Panes" | "Folders" | "Actions" | "UI" | "Misc";

export interface KeyBinding {
  /** Single-char, two-char buffered sequence (e.g. `gg`), or Ctrl-prefixed (e.g. `C-d`). */
  keys: string;
  /** Internal command id consumed by `runNormalCmd` in App.tsx. */
  cmd: string;
  /** One-line description shown in the help modal. */
  desc: string;
  /** Section group used by the help modal's two-column unfiltered layout. */
  category: KeyCategory;
}

export const defaultBindings: KeyBinding[] = [
  // Movement — vim motion verbs adapted to Gmail's list panes.
  { keys: "j", cmd: "cursor.down", desc: "Cursor down", category: "Movement" },
  { keys: "k", cmd: "cursor.up", desc: "Cursor up", category: "Movement" },
  { keys: "gg", cmd: "cursor.top", desc: "Top of list", category: "Movement" },
  { keys: "G", cmd: "cursor.bottom", desc: "Bottom of list", category: "Movement" },
  { keys: "C-d", cmd: "cursor.half-page-down", desc: "Half page down", category: "Movement" },
  { keys: "C-u", cmd: "cursor.half-page-up", desc: "Half page up", category: "Movement" },
  { keys: "C-f", cmd: "cursor.page-down", desc: "Page down", category: "Movement" },
  { keys: "C-b", cmd: "cursor.page-up", desc: "Page up", category: "Movement" },
  { keys: "H", cmd: "cursor.top", desc: "High (top of list)", category: "Movement" },
  { keys: "M", cmd: "cursor.middle", desc: "Middle of list", category: "Movement" },
  { keys: "L", cmd: "cursor.bottom", desc: "Low (bottom of list)", category: "Movement" },
  // Per-level navigation that works regardless of pane focus. The drill
  // model still applies for `j`/`k`/`l`/`h` — but these dedicated cursors
  // let the user step messages or threads while the detail pane stays
  // visible. Mirrors a power-user model where j/k = "smallest unit"
  // (line/body), arrows = "medium unit" (message), [/] = "largest unit"
  // (thread).
  { keys: "Up", cmd: "msg.cursor.up", desc: "Previous message in thread", category: "Movement" },
  { keys: "Down", cmd: "msg.cursor.down", desc: "Next message in thread", category: "Movement" },
  { keys: "[", cmd: "thread.prev", desc: "Previous thread (auto-open)", category: "Movement" },
  { keys: "]", cmd: "thread.next", desc: "Next thread (auto-open)", category: "Movement" },

  // Panes — focus + open/close conventions reused from vim window control.
  { keys: "h", cmd: "pane.close", desc: "Collapse current pane", category: "Panes" },
  { keys: "l", cmd: "pane.open", desc: "Open / focus next pane", category: "Panes" },
  { keys: "Enter", cmd: "pane.open", desc: "Open selected thread / message", category: "Panes" },
  { keys: "q", cmd: "pane.close", desc: "Close current pane", category: "Panes" },
  { keys: "Q", cmd: "app.quit", desc: "Quit application", category: "Panes" },
  { keys: "Tab", cmd: "pane.cycle", desc: "Cycle focus across panes", category: "Panes" },
  {
    keys: "z",
    cmd: "ui.preview-toggle",
    desc: "Toggle preview (focus message)",
    category: "Panes",
  },

  // Folders — `g` prefix mirrors Gmail's keyboard shortcuts so a Gmail user's
  // muscle memory carries over verbatim.
  { keys: "gi", cmd: "nav.folder.inbox", desc: "Go to Inbox", category: "Folders" },
  { keys: "gs", cmd: "nav.folder.sent", desc: "Go to Sent", category: "Folders" },
  { keys: "gd", cmd: "nav.folder.drafts", desc: "Go to Drafts", category: "Folders" },
  { keys: "gt", cmd: "nav.folder.trash", desc: "Go to Trash", category: "Folders" },
  { keys: "gS", cmd: "nav.folder.starred", desc: "Go to Starred", category: "Folders" },
  { keys: "gI", cmd: "nav.folder.important", desc: "Go to Important", category: "Folders" },
  { keys: "ga", cmd: "ui.account", desc: "Open account switcher", category: "Folders" },

  // Actions — Gmail-side state changes on the currently-selected message
  // (or its containing thread for archive/star).
  { keys: "r", cmd: "msg.reply", desc: "Reply to selected (editor)", category: "Actions" },
  { keys: "R", cmd: "msg.reply-all", desc: "Reply-all (editor)", category: "Actions" },
  { keys: "c", cmd: "msg.compose", desc: "Compose new email (editor)", category: "Actions" },
  { keys: "f", cmd: "msg.forward", desc: "Forward selected (editor)", category: "Actions" },
  { keys: "e", cmd: "msg.draft.edit", desc: "Edit selected draft (editor)", category: "Actions" },
  { keys: "a", cmd: "msg.archive", desc: "Archive (remove from Inbox)", category: "Actions" },
  { keys: "A", cmd: "msg.archive-thread", desc: "Archive entire thread", category: "Actions" },
  { keys: "s", cmd: "msg.star", desc: "Star / unstar selected", category: "Actions" },
  { keys: "m", cmd: "msg.read", desc: "Mark read / unread", category: "Actions" },
  { keys: "x", cmd: "msg.delete", desc: "Delete selected (confirm)", category: "Actions" },
  { keys: "t", cmd: "msg.label.add", desc: "Add label (prompt)", category: "Actions" },
  { keys: "T", cmd: "msg.label.remove", desc: "Remove label (prompt)", category: "Actions" },
  { keys: "!", cmd: "msg.spam", desc: "Mark as spam", category: "Actions" },

  // UI — overlays + escape hatch.
  { keys: "/", cmd: "ui.search", desc: "Open search bar", category: "UI" },
  { keys: ":", cmd: "ui.command", desc: "Open command palette", category: "UI" },
  { keys: "p", cmd: "drafts.recover", desc: "Recover local drafts", category: "UI" },
  { keys: "?", cmd: "ui.help", desc: "Toggle help overlay", category: "UI" },
  { keys: "~", cmd: "ui.stats", desc: "Toggle dev stats modal", category: "UI" },
  { keys: "Escape", cmd: "ui.cancel", desc: "Cancel / clear key buffer", category: "UI" },

  // Misc — clipboard + small utilities.
  { keys: "y", cmd: "clip.thread-id", desc: "Copy threadId to clipboard", category: "Misc" },
  { keys: "Y", cmd: "clip.message-id", desc: "Copy messageId to clipboard", category: "Misc" },
  {
    keys: "d",
    cmd: "attach.download",
    desc: "Download all attachments to ~/Downloads",
    category: "Misc",
  },
  {
    keys: "i",
    cmd: "attach.preview",
    desc: "Open first image attachment (system viewer)",
    category: "Misc",
  },
];

/** Resolve a key (possibly with buffered prefix) to a command id, or null. */
export function resolveKey(buffer: string, key: string): { cmd: string | null; pending: boolean } {
  const combined = buffer + key;
  // Exact match wins
  const exact = defaultBindings.find((b) => b.keys === combined);
  if (exact) return { cmd: exact.cmd, pending: false };
  // Prefix match → keep buffering
  const isPrefix = defaultBindings.some((b) => b.keys.startsWith(combined) && b.keys !== combined);
  if (isPrefix) return { cmd: null, pending: true };
  // No match — try the raw single key (drop buffer)
  const single = defaultBindings.find((b) => b.keys === key);
  return { cmd: single?.cmd ?? null, pending: false };
}
