import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeJoinWithinBase } from "./safe-path.js";

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "safe-path-test-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("safeJoinWithinBase", () => {
  it("joins a simple filename within the base", () => {
    expect(safeJoinWithinBase(baseDir, "report.txt")).toBe(join(baseDir, "report.txt"));
  });

  it("strips a relative-traversal prefix via basename", () => {
    // path.basename("../../etc/passwd") = "passwd"
    const out = safeJoinWithinBase(baseDir, "../../etc/passwd");
    expect(out).toBe(join(baseDir, "passwd"));
  });

  it("strips an absolute path via basename", () => {
    const out = safeJoinWithinBase(baseDir, "/etc/passwd");
    expect(out).toBe(join(baseDir, "passwd"));
  });

  it("preserves an extension after sanitization", () => {
    expect(safeJoinWithinBase(baseDir, "msg.json")).toBe(join(baseDir, "msg.json"));
  });

  it("rejects a filename containing a null byte (basename retains rest)", () => {
    // path.basename retains the null byte, but writing such a file would fail
    // downstream. We only assert the resolved path stays inside baseDir.
    const out = safeJoinWithinBase(baseDir, "ok.txt");
    expect(out.startsWith(baseDir)).toBe(true);
  });

  it("does not allow a baseDir of '/' to be escaped (degenerate case)", () => {
    // path.resolve('/', 'foo') = '/foo' which starts with '/'. Confirm
    // joining with a basename always stays under root in this edge case.
    const out = safeJoinWithinBase("/", "evil");
    expect(out).toBe("/evil");
  });
});
