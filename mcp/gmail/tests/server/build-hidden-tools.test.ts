// Account meta-tools are hidden from the MCP surface.
//
// Covers checklist #2: list_accounts / switch_account must not be enumerable
// or callable by a remote MCP client, while in-process CLI/TUI dispatch keeps
// working. Uses only public APIs (tool definitions + dispatch) — no private
// SDK handler access.

import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../src/core/registry.js";
import {
  _resetForTests as resetSession,
  setAuthorizedScopes,
  setSession,
} from "../../src/core/session.js";
import { buildMcpServer } from "../../src/server/build.js";
import { toolDefinitions } from "../../src/tools.js";

beforeEach(() => {
  resetSession();
  // Real client instances (no casts); the registry is mocked below.
  const oauth2Client = new OAuth2Client();
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  setSession({ oauth2Client, gmail });
  delete process.env.MCP_TOOL_TIMEOUT_FORCE_MS;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mcpHidden account meta-tools", () => {
  it("flags list_accounts and switch_account as mcpHidden in the tool catalogue", () => {
    const byName = new Map(toolDefinitions.map((t) => [t.name, t]));
    expect(byName.get("list_accounts")?.mcpHidden).toBe(true);
    expect(byName.get("switch_account")?.mcpHidden).toBe(true);
    // Sanity: ordinary tools are not hidden.
    expect(byName.get("send_email")?.mcpHidden).not.toBe(true);
  });

  it("rejects mcpHidden tools on tools/call over MCP (viaMcp) while in-process dispatch stays allowed", async () => {
    setAuthorizedScopes(["gmail.full", "gmail.settings.basic"]);
    const { dispatch } = buildMcpServer();
    vi.spyOn(registry, "has").mockReturnValue(true);
    const dispatchSpy = vi
      .spyOn(registry, "dispatch")
      .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    // Over the MCP wire surface: rejected, and the op never runs.
    const blocked = await dispatch("switch_account", { accountId: "x" }, undefined, {
      viaMcp: true,
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]?.text).toContain("not available over MCP");
    expect(dispatchSpy).not.toHaveBeenCalled();

    // In-process (CLI/TUI) dispatch: allowed through to the registry.
    const allowed = await dispatch("switch_account", { accountId: "x" });
    expect(allowed.isError).not.toBe(true);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});
