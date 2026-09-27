// `gmail unread` — read-only cross-account unread summary (the unread_summary
// tool). Aggregates unread counts across every configured account WITHOUT
// changing the active account, so there's no need to switch back and forth.

import { Command } from "commander";
import { runCliOp } from "../runtime.js";

export function buildUnreadCommand(): Command {
  const cmd = new Command("unread");
  cmd
    .description("Summarise unread mail across all configured accounts (read-only)")
    .option("--samples", "Include up to 5 sample unread inbox subjects per account")
    .option("--json", "Emit typed JSON")
    .action(async (options: { samples?: boolean; json?: boolean }) => {
      await runCliOp("unread_summary", { includeSamples: options.samples ?? false }, options);
    });
  return cmd;
}
