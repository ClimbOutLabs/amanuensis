import { describe, expect, it, vi } from "vitest";
import {
  findCliScopesArg,
  InvalidScopeError,
  isNonInteractive,
  resolveScopes,
} from "./auth-scopes.js";
import { DEFAULT_SCOPES } from "./scopes.js";

const stubPrompt = vi.fn(async () => ["gmail.readonly"]) as any;

describe("findCliScopesArg", () => {
  it("returns null when missing", () => {
    expect(findCliScopesArg(["node", "auth"])).toBeNull();
  });

  it("extracts scope value", () => {
    expect(findCliScopesArg(["auth", "--scopes=gmail.readonly"])).toBe("gmail.readonly");
  });

  it("returns empty string when flag has no value (treated as explicit)", () => {
    expect(findCliScopesArg(["auth", "--scopes="])).toBe("");
  });
});

describe("isNonInteractive", () => {
  it("returns true with --non-interactive", () => {
    expect(isNonInteractive(["--non-interactive"], {}, true)).toBe(true);
  });

  it("returns true when CI=true", () => {
    expect(isNonInteractive([], { CI: "true" }, true)).toBe(true);
  });

  it("returns true when CI=1", () => {
    expect(isNonInteractive([], { CI: "1" }, true)).toBe(true);
  });

  it("ignores CI=false / 0 / empty", () => {
    expect(isNonInteractive([], { CI: "false" }, true)).toBe(false);
    expect(isNonInteractive([], { CI: "0" }, true)).toBe(false);
    expect(isNonInteractive([], { CI: "" }, true)).toBe(false);
  });

  it("returns true when GMAIL_AUTH_NON_INTERACTIVE=1", () => {
    expect(isNonInteractive([], { GMAIL_AUTH_NON_INTERACTIVE: "1" }, true)).toBe(true);
  });

  it("returns true when stdin is not a TTY", () => {
    expect(isNonInteractive([], {}, false)).toBe(true);
  });

  it("returns false in plain interactive shell", () => {
    expect(isNonInteractive([], {}, true)).toBe(false);
  });
});

describe("resolveScopes precedence", () => {
  it("CLI flag wins over env and prompt", async () => {
    const prompt = vi.fn();
    const result = await resolveScopes({
      argv: ["--scopes=gmail.readonly,gmail.labels"],
      env: { GMAIL_SCOPES: "gmail.modify" },
      isTTY: true,
      prompt: prompt as any,
    });
    expect(result.scopes).toEqual(["gmail.readonly", "gmail.labels"]);
    expect(result.source).toBe("cli");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("env var wins over interactive prompt", async () => {
    const prompt = vi.fn();
    const result = await resolveScopes({
      argv: [],
      env: { GMAIL_SCOPES: "gmail.send  gmail.compose" },
      isTTY: true,
      prompt: prompt as any,
    });
    expect(result.scopes).toEqual(["gmail.send", "gmail.compose"]);
    expect(result.source).toBe("env");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("ignores empty/whitespace env var", async () => {
    const prompt = vi.fn(async () => ["gmail.modify"]) as any;
    const result = await resolveScopes({
      argv: [],
      env: { GMAIL_SCOPES: "   " },
      isTTY: true,
      prompt,
    });
    expect(result.source).toBe("interactive");
  });

  it("falls back to defaults when non-interactive and no other source", async () => {
    const prompt = vi.fn();
    const result = await resolveScopes({
      argv: ["--non-interactive"],
      env: {},
      isTTY: true,
      prompt: prompt as any,
    });
    expect(result.scopes).toEqual(DEFAULT_SCOPES);
    expect(result.source).toBe("default");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("falls back to defaults when stdin is not a TTY", async () => {
    const prompt = vi.fn();
    const result = await resolveScopes({
      argv: [],
      env: {},
      isTTY: false,
      prompt: prompt as any,
    });
    expect(result.scopes).toEqual(DEFAULT_SCOPES);
    expect(result.source).toBe("default");
  });

  it("calls the interactive prompt and returns its selection", async () => {
    const prompt = vi.fn(async () => ["gmail.modify", "gmail.compose"]) as any;
    const result = await resolveScopes({
      argv: [],
      env: {},
      isTTY: true,
      prompt,
    });
    expect(result.scopes).toEqual(["gmail.modify", "gmail.compose"]);
    expect(result.source).toBe("interactive");
    expect(prompt).toHaveBeenCalledOnce();
    const config = prompt.mock.calls[0][0];
    // Defaults should be pre-checked.
    const checkedNames = config.choices.filter((c: any) => c.checked).map((c: any) => c.value);
    expect(checkedNames).toEqual(DEFAULT_SCOPES);
    expect(config.required).toBe(true);
  });
});

describe("resolveScopes validation", () => {
  it("throws InvalidScopeError for unknown scope from CLI", async () => {
    await expect(
      resolveScopes({
        argv: ["--scopes=gmail.bogus"],
        env: {},
        isTTY: true,
        prompt: stubPrompt,
      }),
    ).rejects.toBeInstanceOf(InvalidScopeError);
  });

  it("throws InvalidScopeError for unknown scope from env", async () => {
    await expect(
      resolveScopes({
        argv: [],
        env: { GMAIL_SCOPES: "gmail.modify,gmail.fake" },
        isTTY: true,
        prompt: stubPrompt,
      }),
    ).rejects.toBeInstanceOf(InvalidScopeError);
  });

  it("InvalidScopeError lists the offending scopes", async () => {
    try {
      await resolveScopes({
        argv: ["--scopes=foo,gmail.modify,bar"],
        env: {},
        isTTY: true,
        prompt: stubPrompt,
      });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidScopeError);
      expect((e as InvalidScopeError).invalid).toEqual(["foo", "bar"]);
    }
  });
});
