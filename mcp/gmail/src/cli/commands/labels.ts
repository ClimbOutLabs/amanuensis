// `gmail-cli labels …` — list + CRUD.

import { Command } from "commander";
import { runCliOp } from "../runtime.js";

export function buildLabelsCommand(): Command {
  const cmd = new Command("labels");
  cmd.description("Manage Gmail labels");

  cmd
    .command("list")
    .description("List all available labels (system + user)")
    .option("--json", "Emit typed JSON")
    .action(async (options: { json?: boolean }) => {
      await runCliOp("list_email_labels", {}, options);
    });

  cmd
    .command("create")
    .description("Create a new user label")
    .argument("<name>", "Label name")
    .option("--show", "messageListVisibility=show (default: hide)")
    .option("--label-list <vis>", "labelListVisibility (labelShow / labelShowIfUnread / labelHide)")
    .option("--json", "Emit typed JSON")
    .action(
      async (name: string, options: { show?: boolean; labelList?: string; json?: boolean }) => {
        await runCliOp(
          "create_label",
          {
            name,
            messageListVisibility: options.show ? "show" : undefined,
            labelListVisibility: options.labelList,
          },
          { json: options.json },
        );
      },
    );

  cmd
    .command("update <id>")
    .description("Update an existing label")
    .option("--name <name>", "New name")
    .option("--show", "messageListVisibility=show")
    .option("--hide", "messageListVisibility=hide")
    .option("--label-list <vis>", "labelListVisibility")
    .option("--json", "Emit typed JSON")
    .action(
      async (
        id: string,
        options: {
          name?: string;
          show?: boolean;
          hide?: boolean;
          labelList?: string;
          json?: boolean;
        },
      ) => {
        const messageListVisibility = options.show ? "show" : options.hide ? "hide" : undefined;
        await runCliOp(
          "update_label",
          {
            id,
            name: options.name,
            messageListVisibility,
            labelListVisibility: options.labelList,
          },
          { json: options.json },
        );
      },
    );

  cmd
    .command("delete <id>")
    .description("Delete a label (irreversible)")
    .option("--json", "Emit typed JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      await runCliOp("delete_label", { id }, options);
    });

  cmd
    .command("get-or-create <name>")
    .description("Get an existing label by name, or create it")
    .option("--json", "Emit typed JSON")
    .action(async (name: string, options: { json?: boolean }) => {
      await runCliOp("get_or_create_label", { name }, options);
    });

  return cmd;
}
