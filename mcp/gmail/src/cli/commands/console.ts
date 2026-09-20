// `gmail console` — interactive REPL subcommand. See src/cli/console.ts for
// the actual loop + alias table + legend.

import { Command } from "commander";

export function buildConsoleCommand(): Command {
  const cmd = new Command("console");
  cmd
    .description("Launch an interactive REPL with Gmail ops and account switching")
    .action(async () => {
      const { runConsole } = await import("../console.js");
      await runConsole();
    });
  return cmd;
}
