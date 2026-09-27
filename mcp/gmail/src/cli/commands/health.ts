// `gmail-cli health` — runs the health_check canary without touching Gmail.
//
// Same surface as the MCP `health_check` tool: never makes a network call,
// answers instantly. Useful as a CI smoke test or for verifying the binary
// works after install.

import { formatHealthText, readWatchdogState, snapshotHealth } from "@george43g/robustness";
import { Command } from "commander";
import { exitCli } from "../runtime.js";

export interface HealthCommandOptions {
  json?: boolean;
}

export function buildHealthCommand(): Command {
  const cmd = new Command("health");
  cmd
    .description("Run the health_check canary (no Gmail API calls)")
    .option("--json", "Output JSON instead of human-readable text")
    .action((options: HealthCommandOptions) => {
      const snapshot = snapshotHealth(
        {
          toolCalls: 0,
          recentErrors: 0,
        },
        readWatchdogState(),
      );
      if (options.json) {
        process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatHealthText(snapshot)}\n`);
      }
      const ok = snapshot.status === "healthy";
      exitCli(ok ? 0 : 1);
    });
  return cmd;
}
