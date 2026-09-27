// `gmail-cli filters …` — list, get, create, delete, template.

import { Command } from "commander";
import { runCliOp } from "../runtime.js";

export function buildFiltersCommand(): Command {
  const cmd = new Command("filters");
  cmd.description("Manage Gmail filters (server-side rules)");

  cmd
    .command("list")
    .description("List all filters")
    .option("--json", "Emit typed JSON")
    .action(async (options: { json?: boolean }) => {
      await runCliOp("list_filters", {}, options);
    });

  cmd
    .command("get <filterId>")
    .description("Get a single filter by ID")
    .option("--json", "Emit typed JSON")
    .action(async (filterId: string, options: { json?: boolean }) => {
      await runCliOp("get_filter", { filterId }, options);
    });

  cmd
    .command("create")
    .description("Create a custom filter from inline criteria + actions")
    .option("--from <email>", "Match sender")
    .option("--to <email>", "Match recipient")
    .option("--subject <text>", "Match subject")
    .option("--query <q>", "Gmail search query")
    .option("--has-attachment", "Match emails with attachments")
    .option("--add-label <ids>", "Comma-separated label IDs to add")
    .option("--remove-label <ids>", "Comma-separated label IDs to remove")
    .option("--forward <email>", "Forward matches to this address")
    .option("--json", "Emit typed JSON")
    .action(
      async (options: {
        from?: string;
        to?: string;
        subject?: string;
        query?: string;
        hasAttachment?: boolean;
        addLabel?: string;
        removeLabel?: string;
        forward?: string;
        json?: boolean;
      }) => {
        const criteria = {
          from: options.from,
          to: options.to,
          subject: options.subject,
          query: options.query,
          hasAttachment: options.hasAttachment,
        };
        const action = {
          addLabelIds: options.addLabel?.split(",").map((s) => s.trim()),
          removeLabelIds: options.removeLabel?.split(",").map((s) => s.trim()),
          forward: options.forward,
        };
        await runCliOp("create_filter", { criteria, action }, { json: options.json });
      },
    );

  cmd
    .command("delete <filterId>")
    .description("Delete a filter")
    .option("--json", "Emit typed JSON")
    .action(async (filterId: string, options: { json?: boolean }) => {
      await runCliOp("delete_filter", { filterId }, options);
    });

  cmd
    .command("template <template>")
    .description(
      "Create a filter from a predefined template (fromSender / withSubject / withAttachments / largeEmails / containingText / mailingList)",
    )
    .option("--sender <email>", "fromSender: sender email")
    .option("--subject <text>", "withSubject: subject text")
    .option("--text <text>", "containingText: search text")
    .option("--list-id <id>", "mailingList: identifier")
    .option("--size <bytes>", "largeEmails: size in bytes", (v) => Number.parseInt(v, 10))
    .option("--label <ids>", "Comma-separated label IDs to apply")
    .option("--archive", "Archive matches (skip inbox)")
    .option("--mark-read", "Mark matches as read (withSubject only)")
    .option("--mark-important", "Mark matches as important (containingText only)")
    .option("--json", "Emit typed JSON")
    .action(
      async (
        template: string,
        options: {
          sender?: string;
          subject?: string;
          text?: string;
          listId?: string;
          size?: number;
          label?: string;
          archive?: boolean;
          markRead?: boolean;
          markImportant?: boolean;
          json?: boolean;
        },
      ) => {
        const labelIds = options.label?.split(",").map((s) => s.trim());
        await runCliOp(
          "create_filter_from_template",
          {
            template,
            parameters: {
              senderEmail: options.sender,
              subjectText: options.subject,
              searchText: options.text,
              listIdentifier: options.listId,
              sizeInBytes: options.size,
              labelIds,
              archive: options.archive,
              markAsRead: options.markRead,
              markImportant: options.markImportant,
            },
          },
          { json: options.json },
        );
      },
    );

  return cmd;
}
