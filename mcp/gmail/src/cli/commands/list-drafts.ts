// `gmail list-drafts` — read-only list of saved Gmail drafts (the list_drafts
// tool). Surfaces each draft's id, subject, recipients, thread id, and snippet
// so the id can be fed to send-draft / update-draft / delete-draft.

import { Command } from "commander";
import { runCliOp } from "../runtime.js";

export function buildListDraftsCommand(): Command {
  const cmd = new Command("list-drafts");
  cmd
    .description("List saved drafts with subject, recipients, and snippet (read-only)")
    .option("--max <n>", "Maximum drafts to return", (v) => Number.parseInt(v, 10))
    .option("--page-token <token>", "Continuation token from a prior response")
    .option("--json", "Emit typed JSON")
    .action(async (options: { max?: number; pageToken?: string; json?: boolean }) => {
      const args: { maxResults?: number; pageToken?: string } = {};
      if (options.max !== undefined) args.maxResults = options.max;
      if (options.pageToken) args.pageToken = options.pageToken;
      await runCliOp("list_drafts", args, options);
    });
  return cmd;
}
