// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
// MCP Server factory: tools/list + tools/call wired to the Tasks ops.
//
// Per-tool scope enforcement mirrors the gmail server: each tool declares
// the Google scopes it needs, and the dispatcher refuses tools the loaded
// credentials were not granted.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { attachTokenPersistence, loadCredentials } from "../core/credentials.js";
import { completeTask, createTask, deleteTask, listTaskLists, listTasks } from "../core/ops/tasks.js";
import { hasScope, READONLY_FALLBACK_SCOPES } from "../core/scopes.js";
import { VERSION } from "../version.js";

const tasklistField = z.string().optional().describe("Task list ID, defaults to '@default'.");

const listTasksSchema = z.object({
  tasklist: tasklistField,
  showCompleted: z.boolean().optional().describe("Include completed tasks, defaults to false."),
  maxResults: z.number().int().min(1).max(100).optional().describe("Max tasks, defaults to 50."),
  dueMin: z.string().optional().describe("RFC3339 lower bound on due date."),
  dueMax: z.string().optional().describe("RFC3339 upper bound on due date."),
});

const createTaskSchema = z.object({
  tasklist: tasklistField,
  title: z.string().min(1).describe("Task title."),
  notes: z.string().optional().describe("Task notes."),
  due: z.string().optional().describe("Due date/time as RFC3339."),
});

const completeTaskSchema = z.object({
  tasklist: tasklistField,
  taskId: z.string().min(1).describe("ID of the task to complete."),
});

const deleteTaskSchema = z.object({
  tasklist: tasklistField,
  taskId: z.string().min(1).describe("ID of the task to delete."),
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
    name: "list_tasks",
    description: "List tasks (hides completed ones by default).",
    schema: listTasksSchema,
    requiredScopes: ["tasks.readonly"],
    annotations: { readOnlyHint: true },
    run: (auth, args) => listTasks(auth, args as never),
  },
  {
    name: "list_task_lists",
    description: "List the user's task lists.",
    schema: z.object({}),
    requiredScopes: ["tasks.readonly"],
    annotations: { readOnlyHint: true },
    run: auth => listTaskLists(auth),
  },
  {
    name: "create_task",
    description: "Create a task with a title and optional notes and due date.",
    schema: createTaskSchema,
    requiredScopes: ["tasks"],
    annotations: {},
    run: (auth, args) => createTask(auth, args as never),
  },
  {
    name: "complete_task",
    description: "Mark a task complete by ID.",
    schema: completeTaskSchema,
    requiredScopes: ["tasks"],
    annotations: {},
    run: (auth, args) => completeTask(auth, args as never),
  },
  {
    name: "delete_task",
    description: "Delete a task by ID.",
    schema: deleteTaskSchema,
    requiredScopes: ["tasks"],
    annotations: { destructiveHint: true },
    run: (auth, args) => deleteTask(auth, args as never),
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
  const server = new Server({ name: "tasks", version: VERSION }, { capabilities: { tools: {} } });

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
