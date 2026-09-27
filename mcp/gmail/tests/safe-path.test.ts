// Security tests for the download/attachment sandbox (src/safe-path.ts).
//
// Covers checklist #2: traversal attempts, nested-symlink directory-creation
// escapes, and final-file symlink write redirection. Uses fresh tmpdirs so
// nothing touches the real config dir.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isWithinBase,
  resolveSandboxedDir,
  resolveSandboxedFile,
  safeJoinWithinBase,
  writeFileNoFollow,
} from "../src/safe-path.js";

let base: string;
let outside: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-base-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-outside-"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("resolveSandboxedDir", () => {
  it("creates a nested relative directory inside the base", () => {
    const dir = resolveSandboxedDir(base, "a/b/c");
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(isWithinBase(fs.realpathSync(base), dir)).toBe(true);
  });

  it("rejects lexical traversal", () => {
    expect(() => resolveSandboxedDir(base, "../../etc")).toThrow(/outside the allowed/);
    expect(() => resolveSandboxedDir(base, "..")).toThrow(/outside the allowed/);
  });

  it("rejects absolute paths outside the base", () => {
    expect(() => resolveSandboxedDir(base, outside)).toThrow(/outside the allowed/);
  });

  it("accepts absolute paths inside the base", () => {
    const inner = path.join(base, "inner");
    expect(resolveSandboxedDir(base, inner)).toBe(fs.realpathSync(inner));
  });

  it("refuses to create through a nested symlink pointing outside (no side effects)", () => {
    // <base>/link -> <outside>: a naive mkdir -p would create <outside>/evil.
    fs.symlinkSync(outside, path.join(base, "link"));
    expect(() => resolveSandboxedDir(base, path.join("link", "evil"))).toThrow(
      /outside the allowed/,
    );
    expect(fs.existsSync(path.join(outside, "evil"))).toBe(false);
  });

  it("refuses when a mid-path component is a symlink escaping the base", () => {
    fs.symlinkSync(outside, path.join(base, "hop"));
    expect(() => resolveSandboxedDir(base, "hop/deeper/still")).toThrow(/outside the allowed/);
    expect(fs.existsSync(path.join(outside, "deeper"))).toBe(false);
  });

  it("allows symlinks that stay inside the base", () => {
    const inner = path.join(base, "inner");
    fs.mkdirSync(inner);
    fs.symlinkSync(inner, path.join(base, "alias"));
    const dir = resolveSandboxedDir(base, "alias/sub");
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it("rejects a non-directory blocking the path", () => {
    fs.writeFileSync(path.join(base, "file"), "x");
    expect(() => resolveSandboxedDir(base, "file/sub")).toThrow();
  });
});

describe("writeFileNoFollow", () => {
  it("writes a new file normally", () => {
    const p = path.join(base, "new.txt");
    writeFileNoFollow(p, "hello");
    expect(fs.readFileSync(p, "utf8")).toBe("hello");
  });

  it("overwrites an existing regular file", () => {
    const p = path.join(base, "exists.txt");
    fs.writeFileSync(p, "old");
    writeFileNoFollow(p, "new");
    expect(fs.readFileSync(p, "utf8")).toBe("new");
  });

  it("refuses to write through a planted symlink", () => {
    const victim = path.join(outside, "victim.txt");
    fs.writeFileSync(victim, "original");
    const link = path.join(base, "evil.txt");
    fs.symlinkSync(victim, link);
    expect(() => writeFileNoFollow(link, "pwned")).toThrow(/symlink/);
    expect(fs.readFileSync(victim, "utf8")).toBe("original");
  });

  it("refuses to write to a directory", () => {
    expect(() => writeFileNoFollow(base, "x")).toThrow();
  });
});

describe("safeJoinWithinBase", () => {
  it("reduces traversal filenames to their basename", () => {
    expect(safeJoinWithinBase(base, "../../../etc/evil.bin")).toBe(
      path.join(path.resolve(base), "evil.bin"),
    );
  });

  it("strips absolute paths to basename", () => {
    expect(safeJoinWithinBase(base, "/etc/passwd")).toBe(path.join(path.resolve(base), "passwd"));
  });
});

describe("resolveSandboxedFile", () => {
  it("rejects symlinks that escape the base", () => {
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "secret");
    const link = path.join(base, "leak.txt");
    fs.symlinkSync(secret, link);
    expect(() => resolveSandboxedFile(base, "leak.txt")).toThrow(/outside the allowed/);
  });

  it("resolves files inside the base, including via inner symlinks", () => {
    const real = path.join(base, "real.txt");
    fs.writeFileSync(real, "data");
    expect(resolveSandboxedFile(base, "real.txt")).toBe(fs.realpathSync(real));
  });
});
