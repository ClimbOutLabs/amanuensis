// L1: tools/list advertises each operation's outputSchema on the wire.
//
// Drives a real ListTools request through an in-memory MCP transport pair,
// so the assertion covers the actual SDK serialization path — not an
// internal handler map.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetForTests as resetSession,
  setAuthorizedScopes,
  setSession,
} from "../../src/core/session.js";
import { buildMcpServer } from "../../src/server/build.js";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";

interface ListedTool {
  name: string;
  outputSchema?: { type?: string; properties?: Record<string, unknown> };
}

async function listTools(): Promise<ListedTool[]> {
  const { server } = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "l1-test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const response = await client.listTools();
    // The SDK's Tool type already declares outputSchema; narrow to the
    // fields this test asserts on without a cast.
    return response.tools.map((t) => ({
      name: t.name,
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    }));
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

beforeEach(() => {
  resetSession();
  // Real (unauthenticated) client instances — no casts needed.
  setSession({ oauth2Client: new OAuth2Client(), gmail: google.gmail({ version: "v1" }) });
  setAuthorizedScopes(["gmail.full", "gmail.settings.basic"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSession();
});

describe("tools/list outputSchema advertisement (L1)", () => {
  it("advertises outputSchema for ops that declare one", async () => {
    const tools = await listTools();
    const sendEmail = tools.find((t) => t.name === "send_email");
    expect(sendEmail).toBeDefined();
    // The advertised schema is a JSON-Schema object describing the output.
    expect(sendEmail?.outputSchema?.type).toBe("object");
    expect(sendEmail?.outputSchema?.properties).toMatchObject({
      messageId: expect.anything(),
      action: expect.anything(),
    });
  });

  it("advertises outputSchema for every listed tool (all ops declare one)", async () => {
    const tools = await listTools();
    expect(tools.length).toBeGreaterThan(0);
    const without = tools.filter((t) => t.outputSchema === undefined).map((t) => t.name);
    expect(without).toEqual([]);
  });
});
