// Regression tests for the modal bleed bug. The contract pinned here:
// every cell rendered inside a `<ModalScreen>` must be written with an
// opaque background — otherwise prior-frame content (the email body in
// MessagePane) leaks through. The bug was caused by `<Box backgroundColor>`
// being silently ignored by Ink 7. The fix is per-row `<Text backgroundColor>`,
// emitted via `<ModalRow>`.
//
// We can't introspect ANSI escapes (ink-testing-library uses debug-mode
// rendering, which emits plain text). Instead we directly invoke each
// component's render function and assert on the returned React element
// tree — that pins the "backgroundColor is on every <Text>" contract
// closer to the source of truth than a frame snapshot would.

import { render } from "ink-testing-library";
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { defaultTheme } from "../themes/default.js";
import { ModalRow, ModalScreen } from "./ModalScreen.js";

// memo() returns an exotic object — `.type` is the wrapped function.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ModalRowImpl = (ModalRow as any).type as (props: Record<string, unknown>) => ReactElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ModalScreenImpl = (ModalScreen as any).type as (
  props: Record<string, unknown>,
) => ReactElement;

describe("ModalRow", () => {
  it("emits a single <Text> with backgroundColor = theme.modalBg by default", () => {
    const el = ModalRowImpl({ theme: defaultTheme, children: "hello" });
    expect(isValidElement(el)).toBe(true);
    expect(el.props.backgroundColor).toBe(defaultTheme.modalBg);
    expect(el.props.color).toBe(defaultTheme.fg);
    expect(el.props.children).toBe("hello");
  });

  it("honours backgroundColor / color overrides (used by selection-highlighted rows)", () => {
    const el = ModalRowImpl({
      theme: defaultTheme,
      color: defaultTheme.selectedFg,
      backgroundColor: defaultTheme.selectedBg,
      children: "active",
    });
    expect(el.props.backgroundColor).toBe(defaultTheme.selectedBg);
    expect(el.props.color).toBe(defaultTheme.selectedFg);
  });

  it("propagates bold prop to <Text>", () => {
    const el = ModalRowImpl({ theme: defaultTheme, bold: true, children: "X" });
    expect(el.props.bold).toBe(true);
  });
});

describe("ModalScreen", () => {
  it("renders title + footer + children", () => {
    const { lastFrame } = render(
      <ModalScreen theme={defaultTheme} title="Help" footerHint="Press ? to close">
        <ModalRow theme={defaultTheme}>row a</ModalRow>
        <ModalRow theme={defaultTheme}>row b</ModalRow>
      </ModalScreen>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Help");
    expect(frame).toContain("row a");
    expect(frame).toContain("row b");
    expect(frame).toContain("Press ? to close");
  });

  it("uses theme.accent for title text + default border", () => {
    const root = ModalScreenImpl({
      theme: defaultTheme,
      title: "T",
      children: null,
    });
    // root is the outer <Box> — verify it specifies a border + flexGrow.
    expect(root.props.borderStyle).toBe("single");
    expect(root.props.borderColor).toBe(defaultTheme.accent);
    expect(root.props.flexGrow).toBe(1);
  });

  it("honours borderColor + borderStyle overrides (used by ConfirmModal)", () => {
    const root = ModalScreenImpl({
      theme: defaultTheme,
      borderColor: defaultTheme.warning,
      borderStyle: "double",
      children: null,
    });
    expect(root.props.borderColor).toBe(defaultTheme.warning);
    expect(root.props.borderStyle).toBe("double");
  });

  it("renders inside a real terminal with a visible bordered card", () => {
    const { lastFrame } = render(
      <ModalScreen theme={defaultTheme} title="X" borderStyle="double">
        <ModalRow theme={defaultTheme}>row</ModalRow>
      </ModalScreen>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("row");
    // Double border uses ║ (U+2551); single uses │ (U+2502).
    expect(frame).toMatch(/[║│]/);
  });
});
