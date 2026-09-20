import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { OperationContext } from "./context.js";
import { OperationRegistry, type OperationResult } from "./registry.js";

const fakeCtx = (): OperationContext => ({
  gmail: {} as any,
  oauth2Client: {} as any,
  authorizedScopes: ["gmail.modify"],
  toolName: "test_op",
  accountId: null,
});

describe("OperationRegistry", () => {
  it("register / has / get / names work", () => {
    const reg = new OperationRegistry();
    const schema = z.object({ x: z.number() });
    const handler = vi.fn(
      async (input: { x: number }): Promise<OperationResult> => ({
        content: [{ type: "text", text: `x=${input.x}` }],
      }),
    );
    reg.register({ name: "demo", schema, scopes: ["gmail.modify"], handler });

    expect(reg.has("demo")).toBe(true);
    expect(reg.has("missing")).toBe(false);
    expect(reg.get("demo")?.name).toBe("demo");
    expect(reg.names()).toEqual(["demo"]);
  });

  it("rejects duplicate registration", () => {
    const reg = new OperationRegistry();
    const op = {
      name: "demo",
      schema: z.object({}),
      scopes: [],
      handler: async () => ({ content: [] }),
    };
    reg.register(op);
    expect(() => reg.register(op)).toThrow(/duplicate/i);
  });

  it("dispatch parses input via schema and calls handler", async () => {
    const reg = new OperationRegistry();
    const handler = vi.fn(
      async (input: { x: number }): Promise<OperationResult> => ({
        content: [{ type: "text", text: `got x=${input.x}` }],
      }),
    );
    reg.register({
      name: "demo",
      schema: z.object({ x: z.number() }),
      scopes: [],
      handler,
    });
    const result = await reg.dispatch("demo", { x: 42 }, fakeCtx());
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toEqual({ x: 42 });
    expect(result.content[0].text).toBe("got x=42");
  });

  it("dispatch throws ZodError on schema mismatch", async () => {
    const reg = new OperationRegistry();
    reg.register({
      name: "demo",
      schema: z.object({ x: z.number() }),
      scopes: [],
      handler: async () => ({ content: [] }),
    });
    await expect(reg.dispatch("demo", { x: "not-a-number" }, fakeCtx())).rejects.toThrow();
  });

  it("dispatch throws for unregistered name", async () => {
    const reg = new OperationRegistry();
    await expect(reg.dispatch("nope", {}, fakeCtx())).rejects.toThrow(/no op registered/i);
  });
});
