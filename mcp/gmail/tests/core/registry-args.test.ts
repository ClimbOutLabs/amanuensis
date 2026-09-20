// L2: registry.dispatch treats omitted/null arguments as {}.
//
// A tools/call with no "arguments" (or an explicit null) must parse
// against the op's schema as an empty object rather than throwing on
// undefined.

import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { OperationContext } from "../../src/core/context.js";
import { registry } from "../../src/core/registry.js";

function testCtx(): OperationContext {
  // Real (unauthenticated) client instances — no casts needed, and the
  // handlers under test never touch the network.
  return {
    gmail: google.gmail({ version: "v1" }),
    oauth2Client: new OAuth2Client(),
    authorizedScopes: [],
    toolName: "test_no_args",
    accountId: "default",
  };
}

describe("registry.dispatch argument defaults (L2)", () => {
  it("parses undefined arguments as {}", async () => {
    const seen: unknown[] = [];
    registry.register({
      name: "test_no_args_undefined",
      schema: z.object({}),
      scopes: [],
      handler: async (input) => {
        seen.push(input);
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    await registry.dispatch("test_no_args_undefined", undefined, testCtx());
    expect(seen).toEqual([{}]);
  });

  it("parses null arguments as {}", async () => {
    const seen: unknown[] = [];
    registry.register({
      name: "test_no_args_null",
      schema: z.object({}),
      scopes: [],
      handler: async (input) => {
        seen.push(input);
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    await registry.dispatch("test_no_args_null", null, testCtx());
    expect(seen).toEqual([{}]);
  });

  it("still applies schema defaults when arguments are omitted", async () => {
    const seen: unknown[] = [];
    registry.register({
      name: "test_no_args_defaults",
      schema: z.object({ maxResults: z.number().default(10) }),
      scopes: [],
      handler: async (input) => {
        seen.push(input);
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    await registry.dispatch("test_no_args_defaults", undefined, testCtx());
    expect(seen).toEqual([{ maxResults: 10 }]);
  });

  it("does not swallow explicit arguments", async () => {
    const seen: unknown[] = [];
    registry.register({
      name: "test_no_args_explicit",
      schema: z.object({ q: z.string() }),
      scopes: [],
      handler: async (input) => {
        seen.push(input);
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    await expect(
      registry.dispatch("test_no_args_explicit", undefined, testCtx()),
    ).rejects.toThrow();
    await registry.dispatch("test_no_args_explicit", { q: "in:inbox" }, testCtx());
    expect(seen).toEqual([{ q: "in:inbox" }]);
  });
});
