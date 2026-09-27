import { describe, expect, it } from "vitest";
import { canonicalToolName, resolveToolPrefix } from "./tool-prefix.js";

describe("resolveToolPrefix", () => {
  it("defaults to empty and accepts both CLI forms", () => {
    expect(resolveToolPrefix([], {})).toBe("");
    expect(resolveToolPrefix(["mcp", "--tool-prefix=work_"], {})).toBe("work_");
    expect(resolveToolPrefix(["mcp", "--tool-prefix", "personal_"], {})).toBe("personal_");
  });

  it("prefers CLI over GMAIL_MCP_TOOL_PREFIX", () => {
    expect(
      resolveToolPrefix(["mcp", "--tool-prefix=cli_"], { GMAIL_MCP_TOOL_PREFIX: "env_" }),
    ).toBe("cli_");
  });

  it("strips only a matching non-empty prefix", () => {
    expect(canonicalToolName("work_read_email", "work_")).toBe("read_email");
    expect(canonicalToolName("read_email", "work_")).toBe("read_email");
    expect(canonicalToolName("read_email", "")).toBe("read_email");
  });
});
