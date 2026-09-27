// HelpModal smoke + fuzzy-filter behaviour. The full bleed-fix contract is
// covered by ModalScreen.test — these tests just verify the help-specific
// rendering: categorised grid when unfiltered, single-column hit list when
// filtered, fuzzysort ranks archive/spam queries correctly.

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { defaultTheme } from "../themes/default.js";
import { HelpModal } from "./HelpModal.js";

describe("HelpModal — unfiltered", () => {
  it("renders the title + sesh-style prompt + the binding count", () => {
    const { lastFrame } = render(<HelpModal theme={defaultTheme} filter="" cursor={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Keybindings");
    expect(frame).toContain("⚡");
    // The match-count summary names the total binding population.
    expect(frame).toMatch(/\d+ match/);
  });

  it("groups bindings under category headers", () => {
    const { lastFrame } = render(<HelpModal theme={defaultTheme} filter="" cursor={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Movement");
    expect(frame).toContain("Panes");
    expect(frame).toContain("Folders");
    expect(frame).toContain("Actions");
    expect(frame).toContain("UI");
    expect(frame).toContain("Misc");
  });

  it("displays representative bindings from every category", () => {
    const { lastFrame } = render(<HelpModal theme={defaultTheme} filter="" cursor={0} />);
    const frame = lastFrame() ?? "";
    // Movement
    expect(frame).toContain("Cursor down");
    expect(frame).toContain("Half page down");
    // Panes
    expect(frame).toContain("Cycle focus across panes");
    // Folders
    expect(frame).toContain("Go to Inbox");
    // Actions
    expect(frame).toContain("Archive");
    expect(frame).toContain("Forward selected");
    expect(frame).toContain("Mark as spam");
    // Misc
    expect(frame).toContain("Copy threadId to clipboard");
  });
});

describe("HelpModal — filtered", () => {
  it("collapses to a single-column hit list with a filter prompt", () => {
    const { lastFrame } = render(<HelpModal theme={defaultTheme} filter="arch" cursor={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("arch");
    // Archive bindings are the top hits.
    expect(frame).toContain("Archive");
  });

  it("ranks fuzzy queries the user is likely to type", () => {
    const { lastFrame } = render(<HelpModal theme={defaultTheme} filter="spm" cursor={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("spam");
  });

  it("shows a no-matches message when the filter doesn't hit anything", () => {
    const { lastFrame } = render(<HelpModal theme={defaultTheme} filter="xxxxxxxxxx" cursor={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("no matches");
  });

  it("renders without crashing when cursor exceeds hit count", () => {
    // Defensive — App.tsx may dispatch HELP_CURSOR_MOVE before the next
    // render measures the hit list; the component must clamp safely.
    const { lastFrame } = render(<HelpModal theme={defaultTheme} filter="archive" cursor={999} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Archive");
  });
});
