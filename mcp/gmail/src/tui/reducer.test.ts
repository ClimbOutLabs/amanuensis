// Pure reducer + keymap tests. No Ink, no Gmail — verify the state machine
// the TUI is built on without touching IO.

import { describe, expect, it } from "vitest";
import { accountScopedCacheKey } from "./hooks/useCache.js";
import { resolveKey } from "./keymap.js";
import {
  type AppState,
  initialState,
  type LabelList,
  reducer,
  type ThreadList,
  type ThreadView,
} from "./reducer.js";

const fakeLabels: LabelList = {
  count: { total: 3, system: 2, user: 1 },
  system: [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "SENT", name: "SENT", type: "system" },
  ],
  user: [{ id: "Label_1", name: "Releases", type: "user" }],
};

const fakeThreads: ThreadList = {
  resultCount: 2,
  threads: [
    {
      threadId: "t1",
      snippet: "s1",
      historyId: "h1",
      messageCount: 1,
      latestMessage: { from: "a@x.test", subject: "hello", date: "Mon, 1 Jan 2026 00:00:00 +0000" },
    },
    {
      threadId: "t2",
      snippet: "s2",
      historyId: "h2",
      messageCount: 1,
      latestMessage: { from: "b@x.test", subject: "world", date: "Mon, 1 Jan 2026 00:00:00 +0000" },
    },
  ],
};

const fakeThreadView: ThreadView = {
  threadId: "t1",
  messageCount: 1,
  messages: [
    {
      messageId: "m1",
      threadId: "t1",
      from: "a@x.test",
      to: "b@x.test",
      cc: "",
      bcc: "",
      subject: "hello",
      date: "Mon, 1 Jan 2026 00:00:00 +0000",
      body: "body",
      labelIds: ["INBOX"],
      attachments: [],
    },
  ],
};

describe("reducer", () => {
  it("loads labels and threads without mutating prior state", () => {
    const s1 = reducer(initialState, { type: "SET_LABELS", payload: fakeLabels });
    const s2 = reducer(s1, { type: "SET_THREADS", payload: fakeThreads });
    expect(s2.labels).toBe(fakeLabels);
    expect(s2.threads).toBe(fakeThreads);
    expect(s2.threadCursor).toBe(0);
    expect(s2.loading).toBe(false);
    // Original state should be untouched (no mutation).
    expect(initialState.labels).toBeNull();
    expect(initialState.threads).toBeNull();
  });

  it("clamps cursor to thread list bounds", () => {
    let s: AppState = reducer(initialState, { type: "SET_THREADS", payload: fakeThreads });
    s = reducer(s, { type: "CURSOR_DOWN" });
    expect(s.threadCursor).toBe(1);
    // Past end → stays at last
    s = reducer(s, { type: "CURSOR_DOWN" });
    expect(s.threadCursor).toBe(1);
    // CURSOR_UP works
    s = reducer(s, { type: "CURSOR_UP" });
    expect(s.threadCursor).toBe(0);
    // Past start → stays at 0
    s = reducer(s, { type: "CURSOR_UP" });
    expect(s.threadCursor).toBe(0);
  });

  it("CURSOR_BOTTOM jumps to the last item in the focused pane", () => {
    let s: AppState = reducer(initialState, { type: "SET_LABELS", payload: fakeLabels });
    s = { ...s, focus: "sidebar" };
    s = reducer(s, { type: "CURSOR_BOTTOM" });
    expect(s.labelCursor).toBe(2); // 3 items, index 2
  });

  it("CLOSE_PANE walks message → threads → sidebar without clearing the open thread", () => {
    let s: AppState = {
      ...initialState,
      focus: "message",
      thread: { threadId: "t1", messageCount: 1, messages: [] },
    };
    s = reducer(s, { type: "CLOSE_PANE" });
    expect(s.focus).toBe("threads");
    // Thread is preserved so the user can browse the list with the
    // currently-opened email still visible in the detail pane.
    expect(s.thread?.threadId).toBe("t1");
    s = reducer(s, { type: "CLOSE_PANE" });
    expect(s.focus).toBe("sidebar");
    expect(s.thread?.threadId).toBe("t1");
    s = reducer(s, { type: "CLOSE_PANE" });
    // Sidebar is the leftmost; further CLOSE_PANE is a no-op so the user
    // doesn't accidentally trigger a quit by mashing q.
    expect(s.focus).toBe("sidebar");
  });

  it("MSG_CURSOR_MOVE walks messages independently of focus, resetting bodyScroll", () => {
    const s: AppState = {
      ...initialState,
      focus: "view",
      bodyScroll: 42,
      thread: {
        threadId: "t",
        messageCount: 3,
        messages: [{ messageId: "m1" }, { messageId: "m2" }, { messageId: "m3" }],
      } as AppState["thread"],
      messageCursor: 0,
    };
    const next = reducer(s, { type: "MSG_CURSOR_MOVE", payload: +1 });
    expect(next.messageCursor).toBe(1);
    expect(next.bodyScroll).toBe(0);
    // Clamps at end
    const end = reducer({ ...s, messageCursor: 2 }, { type: "MSG_CURSOR_MOVE", payload: +5 });
    expect(end.messageCursor).toBe(2);
  });

  it("THREAD_CURSOR_MOVE walks the thread list independently of focus", () => {
    const s: AppState = {
      ...initialState,
      focus: "view",
      threads: {
        resultCount: 3,
        threads: [{ threadId: "a" }, { threadId: "b" }, { threadId: "c" }],
      } as AppState["threads"],
      threadCursor: 0,
    };
    const next = reducer(s, { type: "THREAD_CURSOR_MOVE", payload: +2 });
    expect(next.threadCursor).toBe(2);
    // Clamps at 0
    const back = reducer({ ...next }, { type: "THREAD_CURSOR_MOVE", payload: -10 });
    expect(back.threadCursor).toBe(0);
  });

  it("QUIT sets the quit flag for the App to read", () => {
    const s = reducer(initialState, { type: "QUIT" });
    expect(s.quit).toBe(true);
  });

  it("TOGGLE_HELP flips the overlay flag", () => {
    expect(initialState.showHelp).toBe(false);
    const s = reducer(initialState, { type: "TOGGLE_HELP" });
    expect(s.showHelp).toBe(true);
    const s2 = reducer(s, { type: "TOGGLE_HELP" });
    expect(s2.showHelp).toBe(false);
  });

  it("SET_SCOPE clears stale account-specific browse state", () => {
    const dirty: AppState = {
      ...initialState,
      labels: fakeLabels,
      labelCursor: 2,
      selectedLabelId: "Label_1",
      threads: fakeThreads,
      threadCursor: 1,
      thread: fakeThreadView,
      messageCursor: 1,
      focus: "message",
      status: "Thread: 1 message",
      loading: false,
      error: "old error",
    };

    const next = reducer(dirty, {
      type: "SET_SCOPE",
      payload: { kind: "selected", accountIds: ["work", "personal"] },
    });

    expect(next.scope).toEqual({ kind: "selected", accountIds: ["work", "personal"] });
    expect(next.labels).toBeNull();
    expect(next.threads).toBeNull();
    expect(next.thread).toBeNull();
    expect(next.labelCursor).toBe(0);
    expect(next.threadCursor).toBe(0);
    expect(next.messageCursor).toBe(0);
    expect(next.selectedLabelId).toBe("INBOX");
    expect(next.focus).toBe("threads");
    expect(next.loading).toBe(true);
    expect(next.error).toBeNull();
    expect(next.status).toBe("Loading inbox…");
  });
});

describe("account-scoped cache keys", () => {
  it("namespaces thread/message ids by account id", () => {
    expect(accountScopedCacheKey("work", "thr_1")).toBe("work:thr_1");
    expect(accountScopedCacheKey("personal", "thr_1")).toBe("personal:thr_1");
  });
});

describe("overlay state machine", () => {
  it("OPEN_OVERLAY(command) flips mode to insert and stores empty buffer", () => {
    const s = reducer(initialState, {
      type: "OPEN_OVERLAY",
      payload: { kind: "command", text: "" },
    });
    expect(s.mode).toBe("insert");
    expect(s.overlay).toEqual({ kind: "command", text: "" });
  });

  it("OVERLAY_INPUT appends characters; OVERLAY_BACKSPACE removes one", () => {
    let s = reducer(initialState, {
      type: "OPEN_OVERLAY",
      payload: { kind: "search", text: "" },
    });
    s = reducer(s, { type: "OVERLAY_INPUT", payload: "i" });
    s = reducer(s, { type: "OVERLAY_INPUT", payload: "n" });
    expect(s.overlay).toEqual({ kind: "search", text: "in" });
    s = reducer(s, { type: "OVERLAY_BACKSPACE" });
    expect(s.overlay).toEqual({ kind: "search", text: "i" });
  });

  it("CLOSE_OVERLAY returns to normal mode and clears overlay", () => {
    let s = reducer(initialState, {
      type: "OPEN_OVERLAY",
      payload: { kind: "command", text: "theme dracula" },
    });
    s = reducer(s, { type: "CLOSE_OVERLAY" });
    expect(s.mode).toBe("normal");
    expect(s.overlay).toEqual({ kind: "none" });
  });

  it("SET_STATUS clears a stale error so a later success isn't masked", () => {
    let s = reducer(initialState, { type: "SET_ERROR", payload: "send failed" });
    expect(s.error).toBe("send failed");
    s = reducer(s, { type: "SET_STATUS", payload: "Email sent" });
    expect(s.error).toBeNull();
    expect(s.status).toBe("Email sent");
  });

  it("OPEN_OVERLAY(confirm-send) carries the send payload and stays in normal mode", () => {
    const s = reducer(initialState, {
      type: "OPEN_OVERLAY",
      payload: {
        kind: "confirm-send",
        to: ["a@b.test"],
        cc: [],
        bcc: [],
        subject: "hi",
        body: "hello",
        threadId: "t1",
        inReplyTo: "<m1>",
        sendKind: "reply",
        draftPath: "/tmp/drafts/reply-x.eml",
      },
    });
    // Confirm-send is not a text-input overlay — mode must remain normal so the
    // y/n keys reach the modal branch rather than the insert buffer.
    expect(s.mode).toBe("normal");
    expect(s.overlay).toMatchObject({ kind: "confirm-send", to: ["a@b.test"], sendKind: "reply" });
  });

  it("CURSOR_DOWN in theme overlay moves the picker cursor instead of the pane cursor", () => {
    let s = reducer(initialState, {
      type: "OPEN_OVERLAY",
      payload: { kind: "theme", cursor: 0 },
    });
    s = reducer(s, { type: "CURSOR_DOWN" });
    expect(s.overlay).toEqual({ kind: "theme", cursor: 1 });
    // The thread cursor is untouched.
    expect(s.threadCursor).toBe(0);
  });

  it("REQUEST_EDITOR sets pendingEditor; CLEAR_EDITOR clears it", () => {
    let s = reducer(initialState, {
      type: "REQUEST_EDITOR",
      payload: { kind: "compose", initialContent: "draft" },
    });
    expect(s.pendingEditor).toEqual({ kind: "compose", initialContent: "draft" });
    s = reducer(s, { type: "CLEAR_EDITOR" });
    expect(s.pendingEditor).toBeNull();
  });

  it("CURSOR_DOWN in account overlay moves the picker cursor", () => {
    let s = reducer(initialState, {
      type: "SET_ACCOUNT_LIST",
      payload: {
        active: { id: "work", source: "env", isLegacyImplicit: false },
        count: 2,
        accounts: [
          { id: "work", emailAddress: null, scopes: null, isDefault: true, isActive: true },
          { id: "personal", emailAddress: null, scopes: null, isDefault: false, isActive: false },
        ],
      },
    });
    s = reducer(s, { type: "OPEN_OVERLAY", payload: { kind: "account", cursor: 0 } });
    s = reducer(s, { type: "CURSOR_DOWN" });
    expect(s.overlay).toEqual({ kind: "account", cursor: 1 });
    // Pane cursor untouched.
    expect(s.threadCursor).toBe(0);
  });

  it("TOGGLE_STATS flips the dev-stats overlay flag", () => {
    expect(initialState.showStats).toBe(false);
    const s = reducer(initialState, { type: "TOGGLE_STATS" });
    expect(s.showStats).toBe(true);
    const s2 = reducer(s, { type: "TOGGLE_STATS" });
    expect(s2.showStats).toBe(false);
  });

  it("SET_LOCAL_DRAFTS stores the list; the drafts picker clamps its cursor in normal mode", () => {
    const drafts = [
      {
        path: "/a",
        filename: "compose-2026-07-27-101500.eml",
        kind: "compose",
        timestamp: "2026-07-27-101500",
        mtimeMs: 2,
        subject: "A",
        to: [],
        snippet: "",
      },
      {
        path: "/b",
        filename: "reply-2026-07-26-090000.eml",
        kind: "reply",
        timestamp: "2026-07-26-090000",
        mtimeMs: 1,
        subject: "B",
        to: [],
        snippet: "",
      },
    ];
    let s = reducer(initialState, { type: "SET_LOCAL_DRAFTS", payload: drafts });
    expect(s.localDrafts).toHaveLength(2);
    s = reducer(s, { type: "OPEN_OVERLAY", payload: { kind: "drafts", cursor: 0 } });
    // The picker is a normal-mode overlay (like theme/account), not insert.
    expect(s.mode).toBe("normal");
    s = reducer(s, { type: "CURSOR_DOWN" });
    expect(s.overlay).toEqual({ kind: "drafts", cursor: 1 });
    // Clamps at the last row rather than running off the end.
    s = reducer(s, { type: "CURSOR_DOWN" });
    expect(s.overlay).toEqual({ kind: "drafts", cursor: 1 });
    expect(s.threadCursor).toBe(0);
  });
});

describe("resolveKey", () => {
  it("matches single-char bindings immediately", () => {
    expect(resolveKey("", "j")).toEqual({ cmd: "cursor.down", pending: false });
    expect(resolveKey("", "Q")).toEqual({ cmd: "app.quit", pending: false });
    expect(resolveKey("", "p")).toEqual({ cmd: "drafts.recover", pending: false });
  });

  it("buffers two-char prefixes like `gg`", () => {
    const first = resolveKey("", "g");
    expect(first.pending).toBe(true);
    expect(first.cmd).toBeNull();
    const second = resolveKey("g", "g");
    expect(second).toEqual({ cmd: "cursor.top", pending: false });
  });

  it("falls through to the single-key binding when the buffered prefix doesn't extend", () => {
    // Buffered "g" + "j" is not a known sequence — the `j` single-key still resolves.
    const result = resolveKey("g", "j");
    expect(result).toEqual({ cmd: "cursor.down", pending: false });
  });

  it("returns null for unknown keys without raising", () => {
    expect(resolveKey("", "@")).toEqual({ cmd: null, pending: false });
  });
});
