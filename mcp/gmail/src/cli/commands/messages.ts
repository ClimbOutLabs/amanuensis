// `gmail-cli modify / delete` — message label edits + delete.

import { Command } from "commander";
import { runCliOp } from "../runtime.js";

export function buildModifyCommand(): Command {
  const cmd = new Command("modify");
  cmd
    .description("Add/remove labels on a single message")
    .argument("<messageId>", "Gmail message ID")
    .option("--add <ids>", "Comma-separated label IDs to add")
    .option("--remove <ids>", "Comma-separated label IDs to remove")
    .option("--json", "Emit typed JSON")
    .action(
      async (messageId: string, options: { add?: string; remove?: string; json?: boolean }) => {
        await runCliOp(
          "modify_email",
          {
            messageId,
            addLabelIds: options.add?.split(",").map((s) => s.trim()),
            removeLabelIds: options.remove?.split(",").map((s) => s.trim()),
          },
          { json: options.json },
        );
      },
    );
  return cmd;
}

export function buildDeleteCommand(): Command {
  const cmd = new Command("delete");
  cmd
    .description("Permanently delete a single message (irreversible)")
    .argument("<messageId>", "Gmail message ID")
    .option("--json", "Emit typed JSON")
    .action(async (messageId: string, options: { json?: boolean }) => {
      await runCliOp("delete_email", { messageId }, options);
    });
  return cmd;
}

export function buildReportPhishingCommand(): Command {
  return new Command("report-phishing")
    .description("Mark a message as spam (closest Gmail API approximation to reporting phishing)")
    .argument("<messageId>", "Gmail message ID")
    .option("--json", "Emit typed JSON")
    .action(async (messageId: string, options: { json?: boolean }) => {
      await runCliOp("report_phishing", { messageId }, { json: options.json });
    });
}
