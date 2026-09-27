// `gmail mcp` — run the MCP server.
//
// Default transport is stdio. `--http` exposes the same MCP via Streamable
// HTTP for remote hosting (Cloud Run, Fly, Pi, VPS, etc.). All bootstrap
// (shutdown handlers, watchdog, OAuth credentials, dispatcher wiring) runs
// in-process via the orchestrator in src/index.ts.

import { Command } from "commander";

export interface McpCommandOptions {
  http?: boolean;
  port?: number;
  bind?: string;
  tokenEnv?: string;
  toolPrefix?: string;
}

export function buildMcpCommand(): Command {
  const cmd = new Command("mcp");
  cmd
    .description("Run the MCP server (stdio by default; --http for remote-mode)")
    .option("--http", "Expose the MCP via Streamable HTTP instead of stdio")
    .option(
      "--tool-prefix <prefix>",
      "Prefix MCP-advertised tool names (or set GMAIL_MCP_TOOL_PREFIX)",
    )
    .option("--port <n>", "HTTP port (default: 8080)", (v) => Number.parseInt(v, 10), 8080)
    .option(
      "--bind <addr>",
      "HTTP bind address (default: 127.0.0.1; set 0.0.0.0 for direct internet — use a reverse proxy instead)",
      "127.0.0.1",
    )
    .option(
      "--token-env <name>",
      "Name of env var holding the bearer token (default: GMAIL_HTTP_TOKEN). Server refuses to start if unset.",
      "GMAIL_HTTP_TOKEN",
    )
    .action(async (_options: McpCommandOptions) => {
      // main() reads --http / --port / --bind / --token-env directly from
      // process.argv, so we don't need to thread the parsed options through.
      // We just need commander to recognise the flags (for --help) and route
      // here.
      const { main } = await import("../../index.js");
      await main();
    });
  return cmd;
}
