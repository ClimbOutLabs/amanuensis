// `gmail account ...` — account lifecycle, auth, and multi-account selection.

import { confirm, input, select } from "@inquirer/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { deleteAccount, renameAccount } from "../../core/account-service.js";
import {
  type AccountAuthStatus,
  checkAllAccountAuthStatusesLive,
  checkAndCacheAccountAuthStatusLive,
} from "../../core/account-status.js";
import {
  AccountNotFoundError,
  getAccountDir,
  listAccounts,
  loadManifest,
  resolveActiveAccount,
  setDefaultAccount,
  validateAccountId,
} from "../../core/accounts.js";
import { type AccountAuthCommandOptions, runAccountAuthCommand } from "../account-auth.js";
import { exitCli } from "../runtime.js";

type AccountAuthCliOptions = Omit<AccountAuthCommandOptions, "account">;

export function buildAccountCommand(): Command {
  const cmd = new Command("account");
  cmd
    .description("Manage Gmail accounts, credentials, and OAuth auth")
    .addHelpText(
      "after",
      `
Examples:
  gmail account                         # interactive account manager
  gmail account auth work               # authenticate or re-authenticate "work"
  gmail account check --all --json      # scriptable auth-health check
  gmail account use work                # set the default account
`,
    )
    .action(async () => {
      if (process.stdin.isTTY) {
        await runAccountManager();
        return;
      }
      cmd.outputHelp();
      exitCli(3);
    });

  cmd
    .command("list")
    .description("List configured accounts in the manifest")
    .option("--json", "Emit JSON instead of the table")
    .action((options: { json?: boolean }) => {
      const items = listAccounts();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
        return;
      }
      printAccountTable();
    });

  cmd
    .command("current")
    .description("Print the active account and how it was resolved")
    .option("--json", "Emit JSON")
    .action((options: { json?: boolean }) => {
      const active = resolveActiveAccount();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(active, null, 2)}\n`);
        return;
      }
      if (active.id) {
        process.stdout.write(`${active.id}  (source: ${active.source})\n`);
      } else {
        process.stdout.write(
          `No active account. Source: ${active.source}. Run \`gmail account auth <id>\` to create one.\n`,
        );
      }
    });

  cmd
    .command("use")
    .description("Set the default account used when --account / GMAIL_ACCOUNT is not supplied")
    .argument("<id>", "Account id to make default")
    .action((id: string) => {
      try {
        validateAccountId(id);
        const m = setDefaultAccount(id);
        process.stdout.write(`Default account set to "${m.defaultAccount}".\n`);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        exitCli(err instanceof AccountNotFoundError ? 2 : 3);
      }
    });

  cmd
    .command("rm")
    .description("Remove an account: deletes its credentials directory and manifest entry")
    .argument("<id>", "Account id to remove")
    .option("--force", "Skip the confirmation prompt")
    .option("--keep-files", "Remove from manifest only; leave the on-disk directory in place")
    .action(async (id: string, options: { force?: boolean; keepFiles?: boolean }) => {
      try {
        validateAccountId(id);
        const manifest = loadManifest();
        if (!manifest?.accounts[id]) throw new AccountNotFoundError(id);
        if (!options.force && process.stdin.isTTY) {
          const ok = await confirm({
            message: `Remove account "${id}"? This deletes credentials at ${getAccountDir(id)}.`,
            default: false,
          });
          if (!ok) {
            process.stderr.write("Aborted.\n");
            return;
          }
        }
        deleteAccount(id, { keepFiles: options.keepFiles });
        process.stdout.write(`Account "${id}" removed.\n`);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        exitCli(err instanceof AccountNotFoundError ? 2 : 3);
      }
    });

  cmd
    .command("auth")
    .description("Authenticate or re-authenticate a Gmail account")
    .argument("[id]", "Account id to authenticate (e.g. 'work', 'personal')")
    .option("-s, --scopes <list>", "Comma- or space-separated Gmail scopes")
    .option("--non-interactive", "Skip the scope-selection prompt")
    .option("--headless", "Don't launch a browser; print the consent URL only")
    .option("--callback <url>", "OAuth callback URL")
    .option("--port <n>", "Port for the local OAuth callback server", (v) => Number.parseInt(v, 10))
    .option(
      "--oauth-path <path>",
      "Path to gcp-oauth.keys.json (default: ~/.gmail-mcp/gcp-oauth.keys.json, or GMAIL_OAUTH_PATH env)",
    )
    .option(
      "--credentials-path <path>",
      "Where to save credentials (default: account-specific path)",
    )
    .option(
      "--print-json",
      "Emit LIVE credentials JSON to stdout instead of writing files. Treat the output as a password — never paste it into chat, logs, or tickets.",
    )
    .action(async (id: string | undefined, options: AccountAuthCliOptions) => {
      try {
        const account = id ?? (await promptForAccountId());
        await runAccountAuthCommand({ ...options, account });
      } catch (err) {
        const e = err as Error & { code?: string };
        process.stderr.write(`Error: ${e.message}\n`);
        exitCli(e.code === "INVALID_SCOPE" ? 3 : 2);
      }
    });

  cmd
    .command("check")
    .description("Check auth health for one account or all accounts")
    .argument("[id]", "Account id to check")
    .option("--all", "Check every configured account")
    .option("--json", "Emit JSON")
    .action(async (id: string | undefined, options: { all?: boolean; json?: boolean }) => {
      try {
        const statuses = options.all
          ? await checkAllAccountAuthStatusesLive()
          : [await checkAndCacheAccountAuthStatusLive(id ?? requiredActiveAccountId())];
        if (options.json) {
          process.stdout.write(
            `${JSON.stringify(options.all ? statuses : statuses[0], null, 2)}\n`,
          );
          return;
        }
        for (const status of statuses) {
          process.stdout.write(
            `${statusMarker(status.status)} ${status.id}: ${status.status} - ${status.message}\n`,
          );
        }
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        exitCli(err instanceof AccountNotFoundError ? 2 : 3);
      }
    });

  cmd
    .command("rename")
    .description("Rename an account id and move its credentials directory")
    .argument("<oldId>", "Existing account id")
    .argument("<newId>", "New account id")
    .action((oldId: string, newId: string) => {
      try {
        renameAccount(oldId, newId);
        process.stdout.write(`Account "${oldId}" renamed to "${newId}".\n`);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        exitCli(err instanceof AccountNotFoundError ? 2 : 3);
      }
    });

  return cmd;
}

function printAccountTable(): void {
  const items = listAccounts();
  if (items.length === 0) {
    process.stdout.write(
      "No accounts in the manifest yet. Run `gmail account auth <id>` to create one.\n",
    );
    return;
  }
  const isTty = process.stdout.isTTY ?? false;
  const decorate = (s: string, fn: (x: string) => string) => (isTty ? fn(s) : s);
  const header = `${"STATUS".padEnd(12)}${"ID".padEnd(18)}${"EMAIL".padEnd(34)}${"SCOPES".padEnd(28)}DEFAULT`;
  process.stdout.write(`${decorate(header, pc.bold)}\n`);
  for (const item of items) {
    const status = statusMarker(item.entry.authStatus ?? "unknown").padEnd(12);
    const id = item.id.padEnd(18);
    const email = (item.entry.emailAddress ?? "-").padEnd(34);
    const scopes = ((item.entry.scopes ?? []).join(",") || "-").padEnd(28);
    const def = item.isDefault ? decorate("✓", pc.green) : "";
    process.stdout.write(`${status}${id}${email}${scopes}${def}\n`);
  }
}

function statusMarker(status: string): string {
  switch (status) {
    case "ok":
      return pc.green("✓");
    case "missing_credentials":
    case "invalid_credentials":
    case "needs_reauth":
      return pc.red("✗");
    case "unverified_limited_scope":
      return pc.yellow("?");
    default:
      return pc.dim("-");
  }
}

function requiredActiveAccountId(): string {
  const active = resolveActiveAccount();
  if (!active.id) {
    throw new Error("No active account. Pass an id or run `gmail account auth <id>` first.");
  }
  return active.id;
}

async function promptForAccountId(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("Account id required in non-interactive mode. Usage: gmail account auth <id>");
  }
  const accounts = listAccounts();
  if (accounts.length > 0) {
    const choice = await select<string>({
      message: "Authenticate which account?",
      choices: [
        ...accounts.map((item) => ({
          name: accountChoiceLabel(item),
          value: item.id,
        })),
        { name: "New account", value: "__new__" },
      ],
    });
    if (choice !== "__new__") return choice;
  }
  const id = await input({
    message: "Account id",
    validate: (value) => {
      try {
        validateAccountId(value);
        return true;
      } catch (err) {
        return (err as Error).message;
      }
    },
  });
  return id;
}

async function runAccountManager(): Promise<void> {
  let refreshBeforeRender = true;
  while (true) {
    if (refreshBeforeRender) {
      await refreshAccountsForInteractiveManager();
      refreshBeforeRender = false;
    }
    process.stdout.write("\n");
    printAccountTable();
    process.stdout.write("\n");
    const action = await select<string>({
      message: "Account action",
      choices: [
        { name: "Authenticate or re-authenticate account", value: "auth" },
        { name: "Check auth health", value: "check" },
        { name: "Set default account", value: "use" },
        { name: "Rename account", value: "rename" },
        { name: "Delete account", value: "delete" },
        { name: "Reveal account paths", value: "paths" },
        { name: "Export env JSON by re-authenticating", value: "export" },
        { name: "Quit", value: "quit" },
      ],
    });

    if (action === "quit") return;
    if (action === "auth") {
      await runAccountAuthCommand({ account: await promptForAccountId() });
      refreshBeforeRender = true;
    } else if (action === "check") {
      const account = await promptExistingAccountId("Check which account?");
      const status = await checkAndCacheAccountAuthStatusLive(account);
      process.stdout.write(`${statusMarker(status.status)} ${status.id}: ${status.message}\n`);
      refreshBeforeRender = true;
    } else if (action === "use") {
      const account = await promptExistingAccountId("Set which account as default?");
      setDefaultAccount(account);
      process.stdout.write(`Default account set to "${account}".\n`);
    } else if (action === "rename") {
      const oldId = await promptExistingAccountId("Rename which account?");
      const newId = await input({ message: "New account id" });
      renameAccount(oldId, newId);
      process.stdout.write(`Account "${oldId}" renamed to "${newId}".\n`);
      refreshBeforeRender = true;
    } else if (action === "delete") {
      const account = await promptExistingAccountId("Delete which account?");
      const ok = await confirm({ message: `Delete account "${account}"?`, default: false });
      if (ok) {
        deleteAccount(account);
        process.stdout.write(`Account "${account}" removed.\n`);
        refreshBeforeRender = true;
      }
    } else if (action === "paths") {
      const account = await promptExistingAccountId("Reveal paths for which account?");
      process.stdout.write(`Account dir: ${getAccountDir(account)}\n`);
    } else if (action === "export") {
      await runAccountAuthCommand({ account: await promptForAccountId(), printJson: true });
    }
  }
}

export async function refreshAccountsForInteractiveManager(
  opts: {
    checkAll?: () => Promise<AccountAuthStatus[]> | AccountAuthStatus[];
    write?: (line: string) => void;
  } = {},
): Promise<void> {
  if (listAccounts().length === 0) return;
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  write(pc.dim("Checking account auth status..."));
  await (opts.checkAll ?? checkAllAccountAuthStatusesLive)();
}

async function promptExistingAccountId(message: string): Promise<string> {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    throw new Error("No accounts configured. Run `gmail account auth <id>` first.");
  }
  return select<string>({
    message,
    choices: accounts.map((item) => ({
      name: accountChoiceLabel(item),
      value: item.id,
    })),
  });
}

function accountChoiceLabel(item: ReturnType<typeof listAccounts>[number]): string {
  const parts = [item.id];
  if (item.entry.emailAddress) parts.push(`<${item.entry.emailAddress}>`);
  if (item.entry.authStatus) parts.push(`[${item.entry.authStatus}]`);
  if (item.isDefault) parts.push("(default)");
  return parts.join(" ");
}
