// AppState + Action union for the TUI. Pure — no React, no Ink, no Gmail
// imports. Anything that touches the network (fetches inbox, opens a thread)
// lives in hooks; the reducer just receives the result via dispatch.

import type { z } from "zod";
import type {
  GetThreadOutputSchema,
  ListAccountsOutputSchema,
  ListEmailLabelsOutputSchema,
  ListInboxThreadsOutputSchema,
} from "../tools.js";
// Type-only import — erased at compile time, so the reducer stays free of the
// node:fs runtime pulled in by drafts-recovery.js.
import type { LocalDraft } from "./drafts-recovery.js";

export type Mode = "normal" | "insert" | "command";
// Drill-down focus order (left → right): each step right (`l` / `pane.open`)
// drills into the selected item; each step left (`h` / `pane.close`) returns
// to the previous level. `message` is the compact list of messages within
// the open thread (yazi-style); `view` is the full-body single message.
export type Pane = "sidebar" | "threads" | "message" | "view";

export type LabelList = z.infer<typeof ListEmailLabelsOutputSchema>;
type BaseThreadList = z.infer<typeof ListInboxThreadsOutputSchema>;
type BaseThreadView = z.infer<typeof GetThreadOutputSchema>;
export type ThreadList = Omit<BaseThreadList, "threads"> & {
  threads: Array<
    BaseThreadList["threads"][number] & { accountId?: string; emailAddress?: string | null }
  >;
};
export type ThreadView = Omit<BaseThreadView, "messages"> & {
  accountId?: string;
  emailAddress?: string | null;
  messages: Array<
    BaseThreadView["messages"][number] & { accountId?: string; emailAddress?: string | null }
  >;
};
export type AccountList = z.infer<typeof ListAccountsOutputSchema>;
export type BrowseScope =
  | { kind: "single"; accountId: string | null }
  | { kind: "all" }
  | { kind: "selected"; accountIds: string[] };

export type Overlay =
  | { kind: "none" }
  | { kind: "command"; text: string }
  | { kind: "search"; text: string }
  | { kind: "confirm"; prompt: string; pendingCmd: string }
  // Preview-and-confirm gate before an editor-composed message actually sends.
  // Carries the parsed payload + the on-disk draft path so the confirm handler
  // can send (and only then discard the draft). reply-all / draft-edit are
  // exempt and never open this.
  | {
      kind: "confirm-send";
      to: string[];
      cc: string[];
      bcc: string[];
      subject: string;
      body: string;
      threadId?: string;
      inReplyTo?: string;
      sendKind: "compose" | "reply";
      draftPath: string;
    }
  | { kind: "theme"; cursor: number }
  | { kind: "account"; cursor: number; selectedIds?: string[] }
  | { kind: "label"; mode: "add" | "remove"; text: string }
  /** Local-draft recovery picker — cursor indexes into `state.localDrafts`. */
  | { kind: "drafts"; cursor: number };

export interface AppState {
  mode: Mode;
  focus: Pane;
  // Sidebar (labels)
  labels: LabelList | null;
  labelCursor: number;
  selectedLabelId: string; // gmail label id, e.g. "INBOX"
  // Thread list pane
  threads: ThreadList | null;
  threadCursor: number;
  /** Background-fetch state for paginated thread lists. The TUI loads one
      page (~50 threads) by default; when the cursor approaches the end
      AND nextPageToken is non-null, the next page is fetched and the
      result is appended via APPEND_THREADS. `loadingMore` guards against
      reentry. `resultSizeEstimate` is Gmail's server-side count for the
      query — surfaced in the title as "X / ~Y" so the user can see they
      haven't seen everything yet. */
  loadingMore: boolean;
  /** Last query used to fetch threads — needed so APPEND_NEXT_PAGE can
      re-use it when fetching the next page. */
  lastThreadsQuery: string;
  // Message reader pane
  thread: ThreadView | null;
  messageCursor: number;
  /** Vertical scroll offset (in body lines) within the open single-message view.
      Zero means "top of body"; bumped by j/k/Ctrl-d/Ctrl-u while focus="view".
      Reset to 0 whenever the user switches messages (messageCursor changes). */
  bodyScroll: number;
  // Modal / overlay state
  showHelp: boolean;
  /** Fuzzysort filter typed into the help modal. Empty = unfiltered grid. */
  helpFilter: string;
  /** Cursor row within the filtered hit list (used only when filter is non-empty). */
  helpCursor: number;
  showStats: boolean;
  overlay: Overlay;
  // Active account chip + cached list for the switcher overlay
  account: AccountList["active"] | null;
  accountList: AccountList | null;
  scope: BrowseScope;
  // Theme (mutable via :theme command)
  themeName: string;
  // Transient status bar text + last action
  status: string;
  loading: boolean;
  error: string | null;
  // Quit signal — App reads this and calls Ink's exit()
  quit: boolean;
  // Pending key sequence (for two-char bindings like `gg`)
  keyBuffer: string;
  /** Locally-persisted `.eml` compose drafts available for recovery, most
      recent first. Populated on demand when the recovery picker opens. */
  localDrafts: LocalDraft[];
  // Editor suspension marker — App reads this and triggers useEditor
  pendingEditor: null | {
    kind: "compose" | "reply" | "reply-all" | "draft-edit";
    initialContent: string;
    /** For reply / reply-all: the source message id. */
    sourceMessageId?: string;
    /** For reply / reply-all: the source thread id (so send_email replies into the same thread). */
    sourceThreadId?: string;
    /** For draft-edit resumed from a server-side draft: the draft id to
        update in place (so we never create a duplicate draft). */
    draftId?: string;
  };
}

export const initialState: AppState = {
  mode: "normal",
  focus: "threads",
  labels: null,
  labelCursor: 0,
  selectedLabelId: "INBOX",
  threads: null,
  threadCursor: 0,
  thread: null,
  messageCursor: 0,
  bodyScroll: 0,
  showHelp: false,
  helpFilter: "",
  helpCursor: 0,
  showStats: false,
  overlay: { kind: "none" },
  account: null,
  accountList: null,
  scope: { kind: "single", accountId: null },
  themeName: "default",
  status: "Loading inbox…",
  loading: true,
  loadingMore: false,
  lastThreadsQuery: "in:inbox",
  error: null,
  quit: false,
  keyBuffer: "",
  localDrafts: [],
  pendingEditor: null,
};

export type Action =
  | { type: "SET_LABELS"; payload: LabelList }
  | { type: "SET_THREADS"; payload: ThreadList }
  /** Append a fetched-on-scroll next page onto the existing threads list,
      replacing nextPageToken and updating resultSizeEstimate. */
  | { type: "APPEND_THREADS"; payload: ThreadList }
  | { type: "SET_LOADING_MORE"; payload: boolean }
  | { type: "SET_LAST_THREADS_QUERY"; payload: string }
  | { type: "SET_THREAD"; payload: ThreadView }
  | { type: "SET_ACCOUNT"; payload: AccountList["active"] | null }
  | { type: "SET_ACCOUNT_LIST"; payload: AccountList | null }
  | { type: "SET_SCOPE"; payload: BrowseScope }
  | { type: "TOGGLE_STATS" }
  | { type: "SET_LOADING"; payload: boolean }
  | { type: "SET_STATUS"; payload: string }
  | { type: "SET_ERROR"; payload: string | null }
  | { type: "SET_MODE"; payload: Mode }
  | { type: "SET_FOCUS"; payload: Pane }
  | { type: "SET_THEME"; payload: string }
  | { type: "CURSOR_DOWN" }
  | { type: "CURSOR_UP" }
  | { type: "CURSOR_TOP" }
  | { type: "CURSOR_BOTTOM" }
  /** Generic cursor delta — used by half-page / page / [ / ] motions where
      the magnitude is computed in App.tsx from the live terminal height. */
  | { type: "CURSOR_MOVE"; payload: number }
  /** Snap cursor to the middle of the current list — vim H/M/L's `M`. */
  | { type: "CURSOR_MIDDLE" }
  | { type: "SELECT_LABEL"; payload: string }
  | { type: "OPEN_THREAD" }
  | { type: "CLOSE_PANE" }
  | { type: "TOGGLE_HELP" }
  | { type: "QUIT" }
  | { type: "APPEND_KEY"; payload: string }
  | { type: "CLEAR_KEY_BUFFER" }
  | { type: "OPEN_OVERLAY"; payload: Overlay }
  | { type: "CLOSE_OVERLAY" }
  | { type: "OVERLAY_INPUT"; payload: string }
  | { type: "OVERLAY_BACKSPACE" }
  | { type: "REQUEST_EDITOR"; payload: NonNullable<AppState["pendingEditor"]> }
  | { type: "CLEAR_EDITOR" }
  /** Load the local-draft recovery list (most recent first) into state. */
  | { type: "SET_LOCAL_DRAFTS"; payload: LocalDraft[] }
  /** Help modal — fuzzy filter input + filtered-list cursor. */
  | { type: "HELP_FILTER_INPUT"; payload: string }
  | { type: "HELP_FILTER_BACKSPACE" }
  | { type: "HELP_CURSOR_MOVE"; payload: number }
  | { type: "HELP_RESET" }
  /** Body scroll inside MessageDetailPane — payload is a line-count delta. */
  | { type: "BODY_SCROLL"; payload: number }
  /** Snap body scroll to a specific offset; pos "end" means bottom of body. */
  | { type: "BODY_SCROLL_ABS"; payload: number | "end" }
  /** Focus-bypassing message-cursor delta. Used by ↑/↓ arrows so the user
      can step through messages within a thread regardless of the current
      pane focus. Resets bodyScroll. */
  | { type: "MSG_CURSOR_MOVE"; payload: number }
  /** Focus-bypassing thread-cursor delta. Used by `[`/`]` so the user can
      browse adjacent threads without first refocusing the thread list. */
  | { type: "THREAD_CURSOR_MOVE"; payload: number };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_LABELS":
      return { ...state, labels: action.payload };
    case "SET_THREADS":
      return {
        ...state,
        threads: action.payload,
        threadCursor: 0,
        loading: false,
        loadingMore: false,
      };
    case "APPEND_THREADS": {
      if (!state.threads) {
        // Should not happen — APPEND assumes a base list — but be safe.
        return {
          ...state,
          threads: action.payload,
          loadingMore: false,
        };
      }
      const merged: ThreadList = {
        ...state.threads,
        resultCount: state.threads.threads.length + action.payload.threads.length,
        threads: [...state.threads.threads, ...action.payload.threads],
        nextPageToken: action.payload.nextPageToken,
        resultSizeEstimate: action.payload.resultSizeEstimate ?? state.threads.resultSizeEstimate,
      };
      return { ...state, threads: merged, loadingMore: false };
    }
    case "SET_LOADING_MORE":
      return { ...state, loadingMore: action.payload };
    case "SET_LAST_THREADS_QUERY":
      return { ...state, lastThreadsQuery: action.payload };
    case "SET_THREAD":
      return {
        ...state,
        thread: action.payload,
        messageCursor: 0,
        bodyScroll: 0,
        focus: "message",
      };
    case "SET_ACCOUNT":
      return { ...state, account: action.payload };
    case "SET_ACCOUNT_LIST":
      return { ...state, accountList: action.payload };
    case "SET_SCOPE":
      return {
        ...state,
        scope: action.payload,
        labels: null,
        labelCursor: 0,
        selectedLabelId: "INBOX",
        threads: null,
        threadCursor: 0,
        thread: null,
        messageCursor: 0,
        focus: "threads",
        status: "Loading inbox…",
        loading: true,
        error: null,
      };
    case "TOGGLE_STATS":
      return { ...state, showStats: !state.showStats };
    case "SET_LOADING":
      return { ...state, loading: action.payload };
    case "SET_STATUS":
      // A fresh status message supersedes any stale error — the status bar
      // renders error over status, so without clearing it a resolved failure
      // (e.g. a send that later succeeds) would keep showing "Error: …".
      return { ...state, status: action.payload, error: null };
    case "SET_ERROR":
      return { ...state, error: action.payload, loading: false };
    case "SET_MODE":
      return { ...state, mode: action.payload };
    case "SET_FOCUS":
      return { ...state, focus: action.payload };
    case "CURSOR_TOP":
      return setCursorAbs(state, 0);
    case "CURSOR_BOTTOM":
      return setCursorAbs(state, "end");
    case "SELECT_LABEL":
      // Clear the previous label's thread list AND any open thread — without
      // this, the auto-open-first-thread useEffect can race the label load
      // and re-fetch (then SET_THREAD) the previous label's first thread,
      // which flips focus back to message and shows stale content under a
      // new label name.
      return {
        ...state,
        selectedLabelId: action.payload,
        threadCursor: 0,
        threads: null,
        thread: null,
        messageCursor: 0,
        loading: true,
        status: "Loading…",
      };
    case "OPEN_THREAD":
      // Triggers an async fetch in App; reducer only flips focus + loading.
      return { ...state, loading: true, status: "Opening thread…" };
    case "CLOSE_PANE":
      // Drill-down inverse: view → message → threads → sidebar. The loaded
      // thread is preserved across focus moves — the detail/message panes
      // stay rendered so the user can browse the thread list with the
      // currently-opened email still visible. The thread is only cleared
      // when the user opens a different one (auto-fetch in App.tsx) or
      // changes label/account (SELECT_LABEL / SET_SCOPE clear it).
      if (state.focus === "view") {
        return { ...state, focus: "message" };
      }
      if (state.focus === "message") {
        return { ...state, focus: "threads" };
      }
      if (state.focus === "threads") {
        return { ...state, focus: "sidebar" };
      }
      return state;
    case "TOGGLE_HELP":
      // Closing help resets the filter + cursor so the next open is fresh.
      return state.showHelp
        ? { ...state, showHelp: false, helpFilter: "", helpCursor: 0 }
        : { ...state, showHelp: true };
    case "HELP_FILTER_INPUT":
      return { ...state, helpFilter: state.helpFilter + action.payload, helpCursor: 0 };
    case "HELP_FILTER_BACKSPACE":
      return {
        ...state,
        helpFilter: state.helpFilter.slice(0, -1),
        helpCursor: 0,
      };
    case "HELP_CURSOR_MOVE":
      // App.tsx clamps the cursor against the current filtered hit count
      // before dispatching this — the reducer just records the new value.
      return { ...state, helpCursor: Math.max(0, state.helpCursor + action.payload) };
    case "HELP_RESET":
      return { ...state, helpFilter: "", helpCursor: 0 };
    case "BODY_SCROLL":
      // App.tsx clamps against the actual body line count before dispatch.
      return { ...state, bodyScroll: Math.max(0, state.bodyScroll + action.payload) };
    case "BODY_SCROLL_ABS":
      return {
        ...state,
        bodyScroll: action.payload === "end" ? Number.MAX_SAFE_INTEGER : action.payload,
      };
    case "MSG_CURSOR_MOVE": {
      const items = state.thread?.messages.length ?? 0;
      const next = clamp(state.messageCursor + action.payload, 0, Math.max(0, items - 1));
      return { ...state, messageCursor: next, bodyScroll: 0 };
    }
    case "THREAD_CURSOR_MOVE": {
      const items = state.threads?.threads.length ?? 0;
      const next = clamp(state.threadCursor + action.payload, 0, Math.max(0, items - 1));
      return { ...state, threadCursor: next };
    }
    case "QUIT":
      return { ...state, quit: true };
    case "APPEND_KEY":
      return { ...state, keyBuffer: state.keyBuffer + action.payload };
    case "CLEAR_KEY_BUFFER":
      return { ...state, keyBuffer: "" };
    case "SET_THEME":
      return { ...state, themeName: action.payload };
    case "OPEN_OVERLAY":
      // Text-input overlays flip to insert mode so chars go into the buffer
      // instead of triggering normal-mode bindings. Confirm / theme / account
      // stay in normal — they have their own modal-aware input branches.
      return {
        ...state,
        overlay: action.payload,
        mode:
          action.payload.kind === "command" ||
          action.payload.kind === "search" ||
          action.payload.kind === "label"
            ? "insert"
            : state.mode,
      };
    case "CLOSE_OVERLAY":
      return { ...state, overlay: { kind: "none" }, mode: "normal" };
    case "OVERLAY_INPUT":
      if (
        state.overlay.kind === "command" ||
        state.overlay.kind === "search" ||
        state.overlay.kind === "label"
      ) {
        return {
          ...state,
          overlay: { ...state.overlay, text: state.overlay.text + action.payload },
        };
      }
      return state;
    case "OVERLAY_BACKSPACE":
      if (
        (state.overlay.kind === "command" ||
          state.overlay.kind === "search" ||
          state.overlay.kind === "label") &&
        state.overlay.text.length > 0
      ) {
        return {
          ...state,
          overlay: { ...state.overlay, text: state.overlay.text.slice(0, -1) },
        };
      }
      return state;
    case "CURSOR_DOWN":
      if (state.overlay.kind === "theme") return overlayThemeCursor(state, +1);
      if (state.overlay.kind === "account") return overlayAccountCursor(state, +1);
      if (state.overlay.kind === "drafts") return overlayDraftsCursor(state, +1);
      return moveCursor(state, +1);
    case "CURSOR_UP":
      if (state.overlay.kind === "theme") return overlayThemeCursor(state, -1);
      if (state.overlay.kind === "account") return overlayAccountCursor(state, -1);
      if (state.overlay.kind === "drafts") return overlayDraftsCursor(state, -1);
      return moveCursor(state, -1);
    case "CURSOR_MOVE":
      return moveCursor(state, action.payload);
    case "CURSOR_MIDDLE":
      return setCursorAbs(state, "middle");
    case "REQUEST_EDITOR":
      return { ...state, pendingEditor: action.payload };
    case "CLEAR_EDITOR":
      return { ...state, pendingEditor: null };
    case "SET_LOCAL_DRAFTS":
      return { ...state, localDrafts: action.payload };
    default:
      return state;
  }
}

function moveCursor(state: AppState, delta: number): AppState {
  if (state.focus === "sidebar") {
    const items = (state.labels?.system.length ?? 0) + (state.labels?.user.length ?? 0);
    const next = clamp(state.labelCursor + delta, 0, Math.max(0, items - 1));
    return { ...state, labelCursor: next };
  }
  if (state.focus === "threads") {
    const items = state.threads?.threads.length ?? 0;
    const next = clamp(state.threadCursor + delta, 0, Math.max(0, items - 1));
    return { ...state, threadCursor: next };
  }
  if (state.focus === "message") {
    const items = state.thread?.messages.length ?? 0;
    const next = clamp(state.messageCursor + delta, 0, Math.max(0, items - 1));
    return { ...state, messageCursor: next, bodyScroll: 0 };
  }
  // `view` focus: j/k scrolls the body, NOT the message cursor. To switch
  // messages while in view, the user `h` back to the list. This matches
  // vim's "open file in window → arrows scroll inside, navigate files via
  // the file list pane".
  return state;
}

function setCursorAbs(state: AppState, pos: number | "end" | "middle"): AppState {
  const resolve = (items: number) =>
    pos === "end"
      ? Math.max(0, items - 1)
      : pos === "middle"
        ? Math.floor(Math.max(0, items - 1) / 2)
        : clamp(pos, 0, Math.max(0, items - 1));
  if (state.focus === "sidebar") {
    const items = (state.labels?.system.length ?? 0) + (state.labels?.user.length ?? 0);
    return { ...state, labelCursor: resolve(items) };
  }
  if (state.focus === "threads") {
    const items = state.threads?.threads.length ?? 0;
    return { ...state, threadCursor: resolve(items) };
  }
  if (state.focus === "message") {
    const items = state.thread?.messages.length ?? 0;
    return { ...state, messageCursor: resolve(items), bodyScroll: 0 };
  }
  return state;
}

function clamp(n: number, min: number, max: number): number {
  if (max < min) return min;
  return n < min ? min : n > max ? max : n;
}

function overlayThemeCursor(state: AppState, delta: number): AppState {
  if (state.overlay.kind !== "theme") return state;
  // 8 themes shipped; the picker reads listThemeNames() at render time.
  // Bound here by the static count to keep the reducer pure.
  const count = 8;
  const next = clamp(state.overlay.cursor + delta, 0, count - 1);
  return { ...state, overlay: { ...state.overlay, cursor: next } };
}

function overlayDraftsCursor(state: AppState, delta: number): AppState {
  if (state.overlay.kind !== "drafts") return state;
  const items = state.localDrafts.length;
  const next = clamp(state.overlay.cursor + delta, 0, Math.max(0, items - 1));
  return { ...state, overlay: { ...state.overlay, cursor: next } };
}

function overlayAccountCursor(state: AppState, delta: number): AppState {
  if (state.overlay.kind !== "account") return state;
  // Single-account TUI: cursor walks 0..(accounts.length - 1). The legacy
  // multi-account `"all"` row at index 0 has been removed; the underlying
  // `BrowseScope` union (kind: "all" | "selected") still exists for the
  // dispatcher layer, but the UI no longer surfaces those modes.
  const items = state.accountList?.accounts.length ?? 0;
  const next = clamp(state.overlay.cursor + delta, 0, Math.max(0, items - 1));
  return { ...state, overlay: { ...state.overlay, cursor: next } };
}
