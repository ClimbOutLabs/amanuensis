import { describe, expect, it } from "vitest";
import { defaultBindings, type KeyCategory, resolveKey } from "./keymap.js";

describe("defaultBindings registry", () => {
  it("declares no duplicate `keys` ids", () => {
    const seen = new Set<string>();
    for (const b of defaultBindings) {
      expect(seen.has(b.keys), `duplicate binding: ${b.keys}`).toBe(false);
      seen.add(b.keys);
    }
  });

  it("classifies every binding into a known category", () => {
    const allowed: KeyCategory[] = ["Movement", "Panes", "Folders", "Actions", "UI", "Misc"];
    for (const b of defaultBindings) {
      expect(allowed).toContain(b.category);
    }
  });

  it("includes every g-prefix folder binding required by the help modal", () => {
    const required = ["gi", "gs", "gd", "gt", "gS", "gI"];
    for (const k of required) {
      expect(defaultBindings.some((b) => b.keys === k)).toBe(true);
    }
  });

  it("includes every Gmail action binding (archive / forward / spam / label / clipboard)", () => {
    const required = ["a", "A", "f", "!", "t", "T", "y", "Y"];
    for (const k of required) {
      expect(defaultBindings.some((b) => b.keys === k)).toBe(true);
    }
  });

  it("includes the C-d/u/f/b paging bindings", () => {
    const required = ["C-d", "C-u", "C-f", "C-b"];
    for (const k of required) {
      expect(defaultBindings.some((b) => b.keys === k)).toBe(true);
    }
  });
});

describe("resolveKey", () => {
  it("returns the bound cmd for an exact single-char match", () => {
    expect(resolveKey("", "j")).toEqual({ cmd: "cursor.down", pending: false });
    expect(resolveKey("", "Q")).toEqual({ cmd: "app.quit", pending: false });
  });

  it("buffers a `g` prefix until the next char arrives", () => {
    expect(resolveKey("", "g")).toEqual({ cmd: null, pending: true });
    expect(resolveKey("g", "g")).toEqual({ cmd: "cursor.top", pending: false });
    expect(resolveKey("g", "i")).toEqual({ cmd: "nav.folder.inbox", pending: false });
    expect(resolveKey("g", "S")).toEqual({ cmd: "nav.folder.starred", pending: false });
  });

  it("falls back to the single-char binding when the buffered combo is unknown", () => {
    // Typing `g` then `x` — `gx` isn't bound but `x` alone is. The dispatcher
    // drops the buffer and fires the single-char match.
    expect(resolveKey("g", "x")).toEqual({ cmd: "msg.delete", pending: false });
  });

  it("returns null for keys that don't match anything", () => {
    expect(resolveKey("", "@")).toEqual({ cmd: null, pending: false });
  });

  it("handles Ctrl-prefixed keys synthesized as `C-<lower>`", () => {
    expect(resolveKey("", "C-d")).toEqual({ cmd: "cursor.half-page-down", pending: false });
    expect(resolveKey("", "C-u")).toEqual({ cmd: "cursor.half-page-up", pending: false });
  });

  it("resolves Escape, Enter, Tab through their special keyName strings", () => {
    expect(resolveKey("", "Escape")).toEqual({ cmd: "ui.cancel", pending: false });
    expect(resolveKey("", "Enter")).toEqual({ cmd: "pane.open", pending: false });
    expect(resolveKey("", "Tab")).toEqual({ cmd: "pane.cycle", pending: false });
  });
});
