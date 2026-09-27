// Pins the terminal suspend/resume contract that keeps Ink from painting
// over an external $EDITOR / image preview:
//   - FullScreenBox renders its children normally.
//   - While suspended it renders NOTHING (display:none output) — so any
//     repaint trigger (resize, stray state change) writes an empty frame
//     instead of corrupting the child process's screen.
//   - The subtree stays MOUNTED across suspension — React state survives
//     the editor round-trip (open thread, cursors, status).
//   - suspendTerminal() resolves only after the empty frame committed;
//     resumeTerminal() restores the children.
//   - Both are no-ops when called redundantly.

import { Text } from "ink";
import { render } from "ink-testing-library";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  FullScreenBox,
  isTerminalSuspended,
  resumeTerminal,
  suspendTerminal,
} from "./fullscreen.js";

afterEach(async () => {
  // Never leak a suspended store into the next test.
  await resumeTerminal();
});

/** Polls lastFrame() until it satisfies `predicate` (React commits async). */
async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const frame = lastFrame() ?? "";
    if (predicate(frame)) return frame;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return lastFrame() ?? "";
}

describe("suspend store", () => {
  it("starts running and flips through suspend/resume", async () => {
    expect(isTerminalSuspended()).toBe(false);
    await suspendTerminal();
    expect(isTerminalSuspended()).toBe(true);
    await resumeTerminal();
    expect(isTerminalSuspended()).toBe(false);
  });

  it("suspend while suspended and resume while running are no-ops", async () => {
    await suspendTerminal();
    await suspendTerminal();
    expect(isTerminalSuspended()).toBe(true);
    await resumeTerminal();
    await resumeTerminal();
    expect(isTerminalSuspended()).toBe(false);
  });

  it("resolves without a mounted FullScreenBox (unit-test contexts)", async () => {
    // No component subscribed — must not hang waiting for a commit.
    await suspendTerminal();
    await resumeTerminal();
  });
});

describe("FullScreenBox", () => {
  it("renders children normally", () => {
    const { lastFrame, unmount } = render(
      <FullScreenBox>
        <Text>hello inbox</Text>
      </FullScreenBox>,
    );
    expect(lastFrame()).toContain("hello inbox");
    unmount();
  });

  it("renders nothing while suspended and restores children on resume", async () => {
    const { lastFrame, unmount } = render(
      <FullScreenBox>
        <Text>hello inbox</Text>
      </FullScreenBox>,
    );
    expect(lastFrame()).toContain("hello inbox");

    await suspendTerminal();
    expect(lastFrame() ?? "").not.toContain("hello inbox");

    await resumeTerminal();
    expect(lastFrame()).toContain("hello inbox");
    unmount();
  });

  it("keeps the subtree mounted across suspension — child state survives", async () => {
    // Mimics App state (open thread, cursor position): set once on mount,
    // must still be there after a suspend/resume round-trip. A `return null`
    // implementation would remount the child and reset this to "initial".
    function Stateful() {
      const [label, setLabel] = useState("initial");
      useEffect(() => {
        setLabel("opened-thread");
      }, []);
      return <Text>state:{label}</Text>;
    }
    const { lastFrame, unmount } = render(
      <FullScreenBox>
        <Stateful />
      </FullScreenBox>,
    );
    await waitForFrame(lastFrame, (f) => f.includes("state:opened-thread"));
    expect(lastFrame()).toContain("state:opened-thread");

    await suspendTerminal();
    expect(lastFrame() ?? "").not.toContain("opened-thread");

    await resumeTerminal();
    await waitForFrame(lastFrame, (f) => f.includes("state:opened-thread"));
    expect(lastFrame()).toContain("state:opened-thread");
    unmount();
  });
});
