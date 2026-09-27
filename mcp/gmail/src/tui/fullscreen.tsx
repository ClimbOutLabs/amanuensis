// Local replacement for the `fullscreen-ink` package, plus the terminal
// suspend/resume controller that package lacks.
//
// Why not fullscreen-ink: while an external process ($EDITOR, image
// preview) owns the terminal, ANY Ink repaint corrupts its screen. There
// are two independent repaint triggers on stdout "resize" — fullscreen-ink's
// useScreenSize AND Ink core's own resize listener — and Ink's is a private
// bound method we can't detach. Instead of chasing listeners, suspension is
// structural: while suspended, FullScreenBox switches to display:none, so
// the committed output is empty and any render (resize, stray state change)
// writes nothing. display:none — NOT `return null` — is load-bearing: it
// keeps the React subtree mounted, so all App state (open thread, cursors,
// status) survives the editor round-trip. Rendering the empty frame also
// resets Ink's output diff, which makes the resume repaint a guaranteed
// full-frame write instead of a stale diff that would leave the child
// process's residue on screen.
//
// Alt-screen handling is manual (enter + clear + home BEFORE Ink's first
// frame, exit after waitUntilExit) rather than Ink 7's native
// `alternateScreen` option. The native option paints the first frame at the
// inherited cursor row — in tmux, `\x1b[?1049h` copies the visible screen
// into the alt buffer instead of clearing it, so the shell prompt stays
// visible above a bottom-anchored frame. Homing the cursor before render
// makes the frame top-anchored on every terminal.

import type { Instance, RenderOptions } from "ink";
import { Box, render, useInput, useStdout } from "ink";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Suspend store — module singleton, mirrors the sessionEvents pattern.
// The TUI is one-per-process, so module state is the honest scope.

type Listener = () => void;

let suspended = false;
const listeners = new Set<Listener>();
let commitWaiters: Array<() => void> = [];
// Set by withFullScreen when the TUI actually starts. Escape writes are
// gated on this so unit tests (no fullscreen instance) never clear the
// developer's terminal.
let activeInstance: Instance | null = null;
let activeStdout: NodeJS.WriteStream | null = null;

// Deterministic path is the FullScreenBox commit effect; the timeout is a
// safety net so a torn-down tree can never wedge the compose flow.
const COMMIT_FALLBACK_MS = 500;

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isTerminalSuspended(): boolean {
  return suspended;
}

/** Called by FullScreenBox's effect after React commits a suspend flip. */
function notifyCommitted(): void {
  const waiters = commitWaiters;
  commitWaiters = [];
  for (const resolve of waiters) resolve();
}

function waitForCommit(): Promise<void> {
  if (listeners.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    commitWaiters.push(resolve);
    setTimeout(resolve, COMMIT_FALLBACK_MS).unref?.();
  });
}

function flip(next: boolean): Promise<void> {
  suspended = next;
  const committed = waitForCommit();
  for (const listener of listeners) listener();
  return committed;
}

/**
 * Hand the terminal to a child process. Resolves once Ink has committed and
 * flushed an empty frame — after that, nothing Ink-side can write to the
 * screen until resumeTerminal(). Finishes by clearing the alt screen and
 * re-showing the cursor for children that don't manage their own.
 */
export async function suspendTerminal(): Promise<void> {
  if (suspended) return;
  await flip(true);
  await activeInstance?.waitUntilRenderFlush?.();
  activeStdout?.write("\x1b[2J\x1b[H\x1b[?25h");
}

/**
 * Take the terminal back. The child may have run its own alternate-screen
 * pair — vim's exit `\x1b[?1049l` lands the terminal on the NORMAL buffer —
 * so re-enter the alt screen and wipe whatever the child left before Ink
 * repaints the full frame (diff against the empty suspend frame).
 */
export async function resumeTerminal(): Promise<void> {
  if (!suspended) return;
  activeStdout?.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l");
  await flip(false);
  await activeInstance?.waitUntilRenderFlush?.();
}

// ---------------------------------------------------------------------------
// Components

export function useScreenSize(): { width: number; height: number } {
  const { stdout } = useStdout();
  const suspendedNow = useSyncExternalStore(subscribe, isTerminalSuspended);
  const [size, setSize] = useState(() => ({ width: stdout.columns, height: stdout.rows }));
  useEffect(() => {
    if (suspendedNow) return;
    const onResize = () => {
      setSize({ width: stdout.columns, height: stdout.rows });
    };
    // Re-read on (re)subscribe — the terminal may have resized mid-suspend.
    onResize();
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, suspendedNow]);
  return size;
}

export function FullScreenBox({ children }: { children: ReactNode }) {
  // Swallow otherwise-unhandled input so stray keys can't shift the layout
  // (same trick fullscreen-ink uses).
  useInput(() => {
    /* swallow stray keys so they can't shift the layout */
  });
  const suspendedNow = useSyncExternalStore(subscribe, isTerminalSuspended);
  const { width, height } = useScreenSize();
  useEffect(() => {
    // Runs after each suspend flip commits — resolves the waiters queued by
    // suspendTerminal/resumeTerminal. The dependency is the trigger; the
    // committed value itself isn't needed.
    void suspendedNow;
    notifyCommitted();
  }, [suspendedNow]);
  // display:none (not `return null`) — the subtree must stay MOUNTED so App
  // state survives suspension; only the output goes empty.
  return (
    <Box width={width} height={height} display={suspendedNow ? "none" : "flex"}>
      {children}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Entry point

export interface FullScreenApp {
  instance: Instance;
  /** Kept for fullscreen-ink API compatibility — rendering already started. */
  start: () => Promise<void>;
  waitUntilExit: () => Promise<void>;
}

export function withFullScreen(node: ReactNode, options?: RenderOptions): FullScreenApp {
  const stdout = options?.stdout ?? process.stdout;
  // Enter the alt screen and home the cursor BEFORE Ink's first frame so the
  // frame is top-anchored (Ink paints at the inherited cursor position).
  stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
  const instance = render(<FullScreenBox>{node}</FullScreenBox>, options);
  activeInstance = instance;
  activeStdout = stdout;
  return {
    instance,
    start: async () => {
      /* rendering begins in render(); kept for a symmetric lifecycle API */
    },
    waitUntilExit: async () => {
      try {
        await instance.waitUntilExit();
      } finally {
        activeInstance = null;
        activeStdout = null;
        // Restore the primary buffer + cursor. Runs after Ink's own unmount
        // writes, so nothing repaints the alt screen after this.
        stdout.write("\x1b[?1049l\x1b[?25h");
      }
    },
  };
}
