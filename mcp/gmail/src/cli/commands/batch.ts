// `gmail-cli batch-modify / batch-delete` — bulk operations.
//
// --ids accepts comma-separated message IDs, or @file (newline-delimited).
// Batch size caps at 500 per call (BATCH_MESSAGE_IDS_MAX).

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { runCliOp } from "../runtime.js";

export function resolveIds(raw: string): string[] {
  if (raw.startsWith("@")) {
    const filePath = path.resolve(raw.slice(1));
    return fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function buildBatchReportPhishingCommand(): Command {
  return new Command("batch-report-phishing")
    .description("Mark many messages as spam (closest Gmail API phishing approximation)")
    .requiredOption(
      "--ids <ids>",
      "Comma-separated message IDs, or '@file.txt' for newline-delimited input",
    )
    .option("--batch-size <n>", "Per-batch size (default 50)", (v) => Number.parseInt(v, 10), 50)
    .option("--json", "Emit typed JSON")
    .action(async (options: { ids: string; batchSize?: number; json?: boolean }) => {
      await runCliOp(
        "batch_report_phishing",
        { messageIds: resolveIds(options.ids), batchSize: options.batchSize },
        { json: options.json },
      );
    });
}

export function buildBatchModifyCommand(): Command {
  const cmd = new Command("batch-modify");
  cmd
    .description("Add/remove labels on many messages at once (max 500)")
    .requiredOption(
      "--ids <ids>",
      "Comma-separated message IDs, or '@file.txt' for newline-delimited input",
    )
    .option("--add <ids>", "Comma-separated label IDs to add")
    .option("--remove <ids>", "Comma-separated label IDs to remove")
    .option("--batch-size <n>", "Per-batch size (default 50)", (v) => Number.parseInt(v, 10), 50)
    .option("--json", "Emit typed JSON")
    .action(
      async (options: {
        ids: string;
        add?: string;
        remove?: string;
        batchSize?: number;
        json?: boolean;
      }) => {
        await runCliOp(
          "batch_modify_emails",
          {
            messageIds: resolveIds(options.ids),
            addLabelIds: options.add?.split(",").map((s) => s.trim()),
            removeLabelIds: options.remove?.split(",").map((s) => s.trim()),
            batchSize: options.batchSize,
          },
          { json: options.json },
        );
      },
    );
  return cmd;
}

export function buildBatchDeleteCommand(): Command {
  const cmd = new Command("batch-delete");
  cmd
    .description("Permanently delete many messages at once (max 500, irreversible)")
    .requiredOption(
      "--ids <ids>",
      "Comma-separated message IDs, or '@file.txt' for newline-delimited input",
    )
    .option("--batch-size <n>", "Per-batch size (default 50)", (v) => Number.parseInt(v, 10), 50)
    .option("--json", "Emit typed JSON")
    .action(async (options: { ids: string; batchSize?: number; json?: boolean }) => {
      await runCliOp(
        "batch_delete_emails",
        {
          messageIds: resolveIds(options.ids),
          batchSize: options.batchSize,
        },
        { json: options.json },
      );
    });
  return cmd;
}
