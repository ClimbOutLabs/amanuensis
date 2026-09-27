// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
// MCP Server factory: tools/list + tools/call wired to the Calendar ops.
//
// Per-tool scope enforcement mirrors the gmail server: each tool declares
// the Google scopes it needs, and the dispatcher refuses tools the loaded
// credentials were not granted.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { loadCredentials } from "../core/credentials.js";
import { attachTokenPersistence } from "../core/credentials.js";
import { createEvent, deleteEvent, listEvents } from "../core/ops/events.js";
import { hasScope, READONLY_FALLBACK_SCOPES } from "../core/scopes.js";
import { VERSION } from "../version.js";

const listEventsSchema = z.object({
  calendarId: z.string().optional().describe("Calendar ID, defaults to 'primary'."),
  timeMin: z.string().optional().describe("RFC3339 lower bound, defaults to now."),
  timeMax: z.string().optional().describe("RFC3339 upper bound, defaults to now + 7 days."),
  maxResults: z.number().int().min(1).max(100).optional().describe("Max events, defaults to 25."),
  query: z.string().optional().describe("Free-text search across event fields."),
});

const createEventSchema = z.object({
  calendarId: z.string().optional().describe("Calendar ID, defaults to 'primary'."),
  title: z.string().min(1).describe("Event title."),
  start: z.string().min(1).describe("Start: RFC3339 date-time or YYYY-MM-DD for all-day."),
  end: z.string().min(1).describe("End: RFC3339 date-time or YYYY-MM-DD for all-day."),
  description: z.string().optional(),
  location: z.string().optional(),
  timeZone: z.string().optional().describe("IANA timezone, e.g. America/Los_Angeles."),
});

const deleteEventSchema = z.object({
  calendarId: z.string().optional().describe("Calendar ID, defaults to 'primary'."),
  eventId: z.string().min(1).describe("ID of the event to delete."),
});

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  requiredScopes: string[];
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
  run: (auth: OAuth2Client, args: Record<string, unknown>) => Promise<unknown>;
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: "list_events",
    description: "List calendar events in a time range (defaults to the next 7 days).",
    schema: listEventsSchema,
    requiredScopes: ["calendar.readonly"],
    annotations: { readOnlyHint: true },
    run: (auth, args) => listEvents(auth, args as never),
  },
  {
    name: "create_event",
    description: "Create a calendar event with a title, start, and end.",
    schema: createEventSchema,
    requiredScopes: ["calendar.events"],
    annotations: {},
    run: (auth, args) => createEvent(auth, args as never),
  },
  {
    name: "delete_event",
    description: "Delete a calendar event by ID.",
    schema: deleteEventSchema,
    requiredScopes: ["calendar.events"],
    annotations: { destructiveHint: true },
    run: (auth, args) => deleteEvent(auth, args as never),
  },
];

export interface ServerContext {
  auth: OAuth2Client;
  /** Granted scopes from the loaded credentials (shorthand names). */
  scopes: string[];
}

/** Load credentials once per process and build the authenticated context. */
export async function createServerContext(): Promise<ServerContext> {
  const loaded = await loadCredentials();
  const client = new OAuth2Client();
  client.setCredentials(loaded.credentials.tokens as never);
  attachTokenPersistence(client, loaded);
  const scopes =
    loaded.credentials.scopes && loaded.credentials.scopes.length > 0
      ? loaded.credentials.scopes
      : READONLY_FALLBACK_SCOPES;
  return { auth: client, scopes };
}

export function buildMcpServer(ctx: ServerContext): Server {
  const server = new Server({ name: "calendar", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS.map(def => ({
      name: def.name,
      description: def.description,
      inputSchema: zodToJsonSchema(def.schema as z.ZodTypeAny),
      annotations: def.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const def = TOOL_DEFS.find(d => d.name === request.params.name);
    if (!def) {
      return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
    }
    if (!hasScope(ctx.scopes, def.requiredScopes)) {
      return {
        content: [
          {
            type: "text",
            text:
              `Tool ${def.name} requires scope ${def.requiredScopes.join(", ")}, ` +
              `but the credentials only grant ${ctx.scopes.join(", ")}. Re-run auth with the needed scopes.`,
          },
        ],
        isError: true,
      };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = def.schema.parse(request.params.arguments ?? {}) as Record<string, unknown>;
    } catch (err) {
      return {
        content: [{ type: "text", text: `Invalid arguments for ${def.name}: ${(err as Error).message}` }],
        isError: true,
      };
    }
    try {
      const result = await def.run(ctx.auth, parsed);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Tool ${def.name} failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}
