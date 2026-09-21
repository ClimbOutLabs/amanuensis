import { describe, expect, it } from "vitest";
import { defaultTheme } from "../themes/default.js";
import { normalize, senderColor, senderDisplayName } from "./sender-color.js";

describe("normalize", () => {
  it("extracts the address from a Name <addr> form", () => {
    expect(normalize("Brian Osborne <bosborne@equitystart.ai>")).toBe("bosborne@equitystart.ai");
    expect(normalize("George Grigorian <ggrigorian@equitystart.ai>")).toBe(
      "ggrigorian@equitystart.ai",
    );
  });

  it("lowercases and trims to keep palette indexes stable across case", () => {
    expect(normalize("Foo <FOO@BAR.com>")).toBe("foo@bar.com");
    expect(normalize("  user@example.com  ")).toBe("user@example.com");
  });

  it("passes through bare addresses", () => {
    expect(normalize("solo@example.com")).toBe("solo@example.com");
  });
});

describe("senderDisplayName", () => {
  it("returns the friendly name when present", () => {
    expect(senderDisplayName("Brian Osborne <bosborne@equitystart.ai>")).toBe("Brian Osborne");
    expect(senderDisplayName('"Sarah No" <sarah.no@example.com>')).toBe("Sarah No");
  });

  it("falls back to the local-part when only an address is present", () => {
    expect(senderDisplayName("solo@example.com")).toBe("solo");
  });

  it("strips outer quotes around display names", () => {
    expect(senderDisplayName('"Armen Grigorian (via Google Workspace)" <ag@x.com>')).toBe(
      "Armen Grigorian (via Google Workspace)",
    );
  });
});

describe("senderColor", () => {
  it("returns a deterministic palette colour for the same address", () => {
    const a = senderColor(defaultTheme, "brian@example.com");
    const b = senderColor(defaultTheme, "brian@example.com");
    expect(a).toBe(b);
  });

  it("ignores case + display-name wrapping when picking a colour", () => {
    const bare = senderColor(defaultTheme, "george@example.com");
    const wrapped = senderColor(defaultTheme, "George Grigorian <GEORGE@example.com>");
    expect(wrapped).toBe(bare);
  });

  it("returns a colour from the theme's accent/warning/success/error/fg palette", () => {
    const valid = new Set([
      defaultTheme.accent,
      defaultTheme.warning,
      defaultTheme.success,
      defaultTheme.error,
      defaultTheme.fg,
    ]);
    for (const sender of [
      "a@example.com",
      "b@example.com",
      "z@example.com",
      "longname.user@some.org",
    ]) {
      expect(valid.has(senderColor(defaultTheme, sender))).toBe(true);
    }
  });
});
