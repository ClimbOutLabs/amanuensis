// `gmail read <messageId> [--json]`

import { Command } from "commander";
import { runCliOp } from "../runtime.js";

export function buildReadCommand(): Command {
  const cmd = new Command("read");
  cmd
    .description("Read an email by message ID")
    .argument("<messageId>", "Gmail message ID")
    .option("--json", "Emit typed JSON instead of human text")
    .action(async (messageId: string, options: { json?: boolean }) => {
      await runCliOp("read_email", { messageId }, options);
    });
  return cmd;
}
