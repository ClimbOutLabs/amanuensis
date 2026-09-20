// Coverage for the local-draft recovery picker. Renders it in a real Ink
// frame (ink-testing-library) and pins the selection-highlight contract via
// direct element inspection (memo().type), mirroring ModalScreen.test.tsx.

import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { LocalDraft } from "../drafts-recovery.js";
import { defaultTheme } from "../themes/default.js";
import { DraftsRecovery } from "./DraftsRecovery.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DraftsRecoveryImpl = (DraftsRecovery as any).type as (
  props: Record<string, unknown>,
) => ReactElement;

function draft(over: Partial<LocalDraft>): LocalDraft {
  return {
    path: "/tmp/drafts/compose-2026-07-27-101500.eml",
    filename: "compose-2026-07-27-101500.eml",
    kind: "compose",
    timestamp: "2026-07-27-101500",
    mtimeMs: 1000,
    subject: "Quarterly plan",
    to: ["team@fixture.test"],
    snippet: "outline attached",
    ...over,
  };
}

describe("DraftsRecovery", () => {
  it("renders each draft's kind, subject, recipients, and snippet", () => {
    const { lastFrame } = render(
      <DraftsRecovery
        drafts={[
          draft({}),
          draft({
            path: "/tmp/drafts/reply-all-2026-07-26-090000.eml",
            kind: "reply-all",
            subject: "Re: migration",
            to: ["lead@fixture.test"],
            snippet: "I can take the runbook",
          }),
        ]}
        cursor={0}
        theme={defaultTheme}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Recover drafts");
    expect(frame).toContain("[compose] Quarterly plan");
    expect(frame).toContain("team@fixture.test");
    expect(frame).toContain("[reply-all] Re: migration");
    expect(frame).toContain("I can take the runbook");
    // Footer documents the picker's key bindings.
    expect(frame).toContain("[Enter] resume");
    expect(frame).toContain("[d] discard");
  });

  it("shows an empty-state message when there are no drafts", () => {
    const { lastFrame } = render(<DraftsRecovery drafts={[]} cursor={0} theme={defaultTheme} />);
    expect(lastFrame() ?? "").toContain("No local drafts to recover.");
  });

  it("falls back to (no subject) for a draft with an empty subject", () => {
    const { lastFrame } = render(
      <DraftsRecovery drafts={[draft({ subject: "", to: [] })]} cursor={0} theme={defaultTheme} />,
    );
    expect(lastFrame() ?? "").toContain("[compose] (no subject)");
  });

  it("highlights the cursor row with the selection colours", () => {
    const root = DraftsRecoveryImpl({
      drafts: [draft({}), draft({ path: "/b", subject: "second" })],
      cursor: 1,
      theme: defaultTheme,
    });
    // Walk the rendered rows and confirm exactly the cursor row is selected.
    const rows = collectRows(root);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.props.backgroundColor).toBe(defaultTheme.modalBg);
    expect(rows[1]?.props.backgroundColor).toBe(defaultTheme.selectedBg);
    expect(rows[1]?.props.color).toBe(defaultTheme.selectedFg);
  });
});

// Recursively gather the ModalRow elements that carry draft text (they render
// a `children` string beginning with "["). Cheap tree walk over the element
// returned by the component's render function.
function collectRows(el: unknown): Array<{ props: Record<string, any> }> {
  const out: Array<{ props: Record<string, any> }> = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const children = node.props?.children;
    if (typeof children === "string" && children.startsWith("[")) {
      out.push(node);
    }
    if (children !== undefined) visit(children);
  };
  visit(el);
  return out;
}
