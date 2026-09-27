// Dispatcher unit tests for src/server/build.ts.
//
// Covers tools/list scope filtering, unknown-tool errors, scope-gated re-auth
// hints, and ToolTimeoutError → isError envelopes.
//
// Strategy: setSession() with a fake oauth+gmail, then call buildMcpServer().
// Invoke the dispatch closure directly for tools/call paths; reach into the
// SDK Server's _requestHandlers map to drive the tools/list handler. We mock
// the registry singleton to isolate dispatcher behaviour from real op
// handlers — the dispatcher is what's under test, not the ops.

import { ToolTimeoutError } from "@george43g/robustness";
import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "../core/registry.js";
import {
  _resetForTests as resetSession,
  setAuthorizedScopes,
  setSession,
} from "../core/session.js";
import { buildMcpServer } from "./build.js";

type RequestHandler = (...args: unknown[]) => unknown;

const fakeOauth = { __isFake: true } as unknown as OAuth2Client;
const fakeGmail = { users: {} } as unknown as gmail_v1.Gmail;

beforeEach(() => {
  resetSession();
  setSession({ oauth2Client: fakeOauth, gmail: fakeGmail });
  // Clear any forced-timeout env left over from other suites.
  delete process.env.MCP_TOOL_TIMEOUT_FORCE_MS;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildMcpServer tools/list scope filter (12.1)", () => {
  it("filters out tools whose required scopes are not in authorizedScopes", async () => {
    // Authorize only the filters scope. Every gmail.* tool should drop out;
    // filter tools (settings.basic) and health_check (no scope) remain.
    setAuthorizedScopes(["gmail.settings.basic"]);
    const { server } = buildMcpServer();

    // SDK keeps the registered handlers on a private map. Drive the
    // tools/list handler directly — same code path the JSON-RPC layer hits.
    const handlers = (server as unknown as { _requestHandlers: Map<string, RequestHandler> })
      ._requestHandlers;
    const listHandler = handlers.get("tools/list");
    expect(listHandler).toBeDefined();

    const response = (await listHandler!(
      { method: "tools/list", params: {} },
      { signal: new AbortController().signal },
    )) as { tools: Array<{ name: string }> };

    const names = response.tools.map((t) => t.name);
    // Filter tools are visible.
    expect(names).toContain("list_filters");
    expect(names).toContain("create_filter");
    expect(names).toContain("delete_filter");
    // health_check requires no scope.
    expect(names).toContain("health_check");
    // Pure gmail.modify tools are hidden.
    expect(names).not.toContain("send_email");
    expect(names).not.toContain("modify_email");
    expect(names).not.toContain("delete_email");
    expect(names).not.toContain("read_email");
  });

  it("returns the full catalogue when broad scopes are granted", async () => {
    setAuthorizedScopes(["gmail.full", "gmail.settings.basic"]);
    const { server } = buildMcpServer();
    const handlers = (server as unknown as { _requestHandlers: Map<string, RequestHandler> })
      ._requestHandlers;
    const listHandler = handlers.get("tools/list")!;
    const response = (await listHandler(
      { method: "tools/list", params: {} },
      { signal: new AbortController().signal },
    )) as { tools: Array<{ name: string }> };
    const names = response.tools.map((t) => t.name);
    // Spot-check a tool from every scope class — the broad-scope path must
    // not silently drop any visible category.
    expect(names).toContain("read_email"); // gmail.readonly|modify
    expect(names).toContain("send_email"); // gmail.modify|compose|send
    expect(names).toContain("list_filters"); // gmail.settings.basic
    expect(names).toContain("health_check"); // no scope
    // Catalogue size matches the stress-harness lower bound.
    expect(response.tools.length).toBeGreaterThanOrEqual(26);
  });
});

describe("buildMcpServer MCP tool prefix", () => {
  it("prefixes tools/list and maps prefixed wire calls while direct dispatch stays canonical", async () => {
    setAuthorizedScopes(["gmail.modify"]);
    const registryDispatch = vi.spyOn(registry, "dispatch").mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    vi.spyOn(registry, "has").mockReturnValue(true);
    const { server, dispatch } = buildMcpServer({ toolPrefix: "work_" });
    const handlers = (server as unknown as { _requestHandlers: Map<string, RequestHandler> })
      ._requestHandlers;
    const listed = (await handlers.get("tools/list")!(
      { method: "tools/list", params: {} },
      { signal: new AbortController().signal },
    )) as { tools: Array<{ name: string }> };
    expect(listed.tools.every((tool) => tool.name.startsWith("work_"))).toBe(true);

    await handlers.get("tools/call")!(
      { method: "tools/call", params: { name: "work_read_email", arguments: { messageId: "m" } } },
      { signal: new AbortController().signal },
    );
    expect(registryDispatch).toHaveBeenCalledWith(
      "read_email",
      { messageId: "m" },
      expect.objectContaining({ toolName: "read_email" }),
    );

    await dispatch("read_email", { messageId: "m" });
    expect(registryDispatch).toHaveBeenLastCalledWith(
      "read_email",
      { messageId: "m" },
      expect.objectContaining({ toolName: "read_email" }),
    );
  });
});

describe("buildMcpServer dispatcher", () => {
  it("rejects an unknown tool name with an error envelope (12.3)", async () => {
    setAuthorizedScopes(["gmail.modify", "gmail.settings.basic"]);
    const { dispatch } = buildMcpServer();

    const result = await dispatch("nonexistent_made_up_tool", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("nonexistent_made_up_tool");
    expect(result.content[0]?.text).toContain("not available");
    expect(result.content[0]?.text).toContain("re-authenticate");
  });

  it("rejects a scope-gated tool with the re-auth hint when scopes are insufficient (12.4)", async () => {
    // Authorize ONLY filters scope, then ask for send_email. send_email
    // requires gmail.modify / gmail.compose / gmail.send — none granted.
    setAuthorizedScopes(["gmail.settings.basic"]);
    const { dispatch } = buildMcpServer();

    const result = await dispatch("send_email", {
      to: ["a@b.com"],
      subject: "x",
      body: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Tool "send_email" is not available');
    expect(result.content[0]?.text).toMatch(/re-authenticate.*additional scopes/i);
  });

  it("converts ToolTimeoutError thrown by the registry into an isError envelope (12.5)", async () => {
    setAuthorizedScopes(["gmail.modify", "gmail.settings.basic"]);

    // Stub registry.has + registry.dispatch so we exercise just the
    // dispatcher's withTimeout/error-handling branch.
    const hasSpy = vi.spyOn(registry, "has").mockReturnValue(true);
    const dispatchSpy = vi.spyOn(registry, "dispatch").mockImplementation(async () => {
      throw new ToolTimeoutError("read_email", 1234);
    });

    const { dispatch } = buildMcpServer();
    const result = await dispatch("read_email", { messageId: "m1" });

    expect(hasSpy).toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('Tool "read_email" timed out after 1234ms');
  });

  it("wraps non-timeout exceptions via wrapToolError (12.7) — non-auth path", async () => {
    setAuthorizedScopes(["gmail.modify", "gmail.settings.basic"]);
    vi.spyOn(registry, "has").mockReturnValue(true);
    vi.spyOn(registry, "dispatch").mockImplementation(async () => {
      throw new Error("kaboom");
    });

    const { dispatch } = buildMcpServer();
    const result = await dispatch("read_email", { messageId: "m1" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("read_email failed");
    expect(result.content[0]?.text).toContain("kaboom");
    // Non-auth error → no re-auth hint.
    expect(result.content[0]?.text).not.toContain("gmail account auth");
  });
});
