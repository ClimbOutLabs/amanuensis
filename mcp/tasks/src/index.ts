// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
// Entry point: `tasks-mcp auth` runs the Google OAuth flow (for stdio use),
// `tasks-mcp mcp` serves MCP over stdio, `tasks-mcp mcp --http`
// serves Streamable HTTP. In HTTP mode the client forwards its Google access
// token as the bearer token; no local credentials or static token are needed.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runAuthFlow, writeCredentialsFile } from "./core/auth-flow.js";
import { buildMcpServer, createServerContext } from "./server/build.js";
import { startHttpServer } from "./server/http.js";
import { VERSION } from "./version.js";

/** Parse `--port N` / `--port=N` safely; returns undefined when absent. */
function parsePort(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && i + 1 < args.length) {
      const next = args[i + 1] as string;
      if (next.startsWith("--")) return undefined;
      const port = Number(next);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid --port value: ${next}`);
      }
      return port;
    }
    if (arg.startsWith("--port=")) {
      const port = Number(arg.slice("--port=".length));
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid --port value: ${arg}`);
      }
      return port;
    }
  }
  return undefined;
}

function printUsage(): void {
  process.stderr.write(
    `tasks-mcp ${VERSION}\n\n` +
      `Usage:\n` +
      `  tasks-mcp auth [--headless] [--port N]   Run the Google OAuth flow\n` +
      `  tasks-mcp mcp [--http] [--port N]        Serve MCP (stdio by default)\n`,
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "auth") {
    const headless = rest.includes("--headless");
    const port = parsePort(rest);
    const result = await runAuthFlow({ headless, ...(port !== undefined ? { port } : {}) });
    const saved = writeCredentialsFile(result);
    process.stderr.write(`Credentials saved to ${saved}\n`);
    return;
  }
  if (command === "mcp" || command === undefined) {
    const useHttp = rest.includes("--http");
    const port = parsePort(rest) ?? 8080;
    if (!useHttp) {
      const ctx = await createServerContext();
      const server = buildMcpServer(ctx);
      const transport = new StdioServerTransport();
      await server.connect(transport);
      return;
    }
    // HTTP mode: the client forwards its Google access token as the bearer
    // token; it is validated per request. No local credentials are needed.
    await startHttpServer({ port, bind: "0.0.0.0" });
    return;
  }
  if (command === "--version" || command === "-V") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  printUsage();
  process.exit(1);
}

main().catch(err => {
  process.stderr.write(`tasks-mcp: ${(err as Error).message}\n`);
  process.exit(1);
});
