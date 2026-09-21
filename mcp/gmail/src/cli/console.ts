// `gmail console` — interactive REPL over the same commander tree as the CLI.
//
// Modeled on imsg-mcp's console:
// a readline prompt feeding one line at a time into `program.parseAsync` so
// console commands stay 1:1 with `gmail` CLI commands. A small alias-rewrite
// table layers snappy two-letter shortcuts (`i` → inbox, `s` → search, …)
// on top of the canonical CLI surface.
//
// Output stays terse and human-readable (no JSON envelope) so `sed`/`awk`/
// `grep` work the way you'd expect inside the session.

import { createInterface } from "node:readline";
import pc from "picocolors";
import { getCurrentAccountId } from "../core/session.js";
import { buildProgram } from "./index.js";
import {
  bootstrapForCli,
  callMcpTool,
  callOp,
  executeCliOp,
  formatToolResultText,
  type ToolResult,
} from "./runtime.js";

type BrowseScope =
  | { kind: "single"; accountId: string | null }
  | { kind: "all" }
  | { kind: "selected"; accountIds: string[] };

// ── Alias table ──────────────────────────────────────────────────────
// Console-only shortcuts. The CLI surface keeps the canonical long names.

const ALIASES: Record<string, string> = {
  i: "inbox",
  s: "search",
  r: "read",
  ra: "reply-all",
  d: "draft",
  t: "threads",
  lab: "labels",
  fil: "filters",
  mod: "modify",
  del: "delete",
  bm: "batch-modify",
  bd: "batch-delete",
  de: "download-email",
  da: "download-attachment",
  h: "health",
  sw: "switch",
};

// ── Tokenizer ────────────────────────────────────────────────────────
// Quote-aware splitter so `s "from:foo bar"` parses as two tokens.
// Copied verbatim from imsg-mcp's parseConsoleInput.

export function parseConsoleInput(line: string): { cmd: string; args: string[] } {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (const char of line) {
    if ((char === '"' || char === "'") && quote == null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (char === " " && quote == null) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return { cmd: parts[0] ?? "", args: parts.slice(1) };
}

/** Apply the console alias rewrite to the first token. Returns the resolved
 *  command name; passes through unknown commands so commander handles the
 *  error message itself. */
export function rewriteAlias(cmd: string): string {
  return ALIASES[cmd] ?? cmd;
}

// ── Legend ───────────────────────────────────────────────────────────

const LEGEND_LINES: Array<{ kind: "header" | "cmd" | "blank"; left?: string; right?: string }> = [
  { kind: "header", left: "Read" },
  { kind: "cmd", left: "i [n]", right: "list inbox threads (alias for `inbox`)" },
  { kind: "cmd", left: "s <query>", right: "search emails (Gmail query syntax)" },
  { kind: "cmd", left: "r <messageId>", right: "read an email" },
  { kind: "cmd", left: "t list|get|modify|inbox", right: "thread-level ops" },
  { kind: "blank" },
  { kind: "header", left: "Write" },
  { kind: "cmd", left: "send -t … -s … -b …", right: "send an email" },
  { kind: "cmd", left: "d -t … -s … -b …", right: "create a draft (alias for `draft`)" },
  { kind: "cmd", left: "ra <id> -b …", right: "reply-all to a message" },
  { kind: "cmd", left: "mod <id> --add|--remove", right: "add/remove labels" },
  { kind: "cmd", left: "del <id>", right: "delete a message (confirms in console)" },
  { kind: "cmd", left: "bm / bd", right: "batch-modify / batch-delete" },
  { kind: "blank" },
  { kind: "header", left: "Manage" },
  { kind: "cmd", left: "lab {list,create,update,delete}", right: "labels" },
  { kind: "cmd", left: "fil {list,get,create,delete}", right: "filters" },
  { kind: "cmd", left: "de <id>", right: "download email to disk" },
  { kind: "cmd", left: "da <msgId> <attId>", right: "download an attachment" },
  { kind: "blank" },
  { kind: "header", left: "Debug" },
  { kind: "cmd", left: "h", right: "health_check (local canary)" },
  { kind: "cmd", left: "tools", right: "list every registered MCP tool" },
  { kind: "cmd", left: "raw <name> <json>", right: "call any tool with raw args" },
  { kind: "blank" },
  { kind: "header", left: "Session" },
  { kind: "cmd", left: "accounts", right: "list configured Gmail accounts" },
  { kind: "cmd", left: "switch <id> / sw <id>", right: "switch this console session account" },
  { kind: "cmd", left: "scope all | scope <ids>", right: "browse all or selected accounts" },
  { kind: "cmd", left: "help / ?", right: "show this legend" },
  { kind: "cmd", left: "clear / cls", right: "clear the screen" },
  { kind: "cmd", left: "quit / q / exit", right: "exit the console" },
];

function printLegend(write: (s: string) => void = (s) => process.stdout.write(`${s}\n`)): void {
  write(pc.bold("gmail console"));
  write(pc.dim("Type a command. Strings can be quoted; arguments work like the CLI."));
  write("");
  for (const row of LEGEND_LINES) {
    if (row.kind === "blank") {
      write("");
      continue;
    }
    if (row.kind === "header") {
      write(pc.bold(pc.cyan(`${row.left}:`)));
      continue;
    }
    const left = (row.left ?? "").padEnd(34);
    write(`  ${pc.green(left)}${row.right ?? ""}`);
  }
  write("");
  write(pc.dim("Tip: short aliases work too (`i 5`, `s from:noreply`, `r <id>`)."));
  write("");
}

// ── Built-in console intercepts ──────────────────────────────────────

/** Built-in commands handled directly by the REPL (not routed through
 *  commander). Returns true if the command was intercepted. */
export function isBuiltinCommand(cmd: string): boolean {
  return (
    cmd === "help" ||
    cmd === "?" ||
    cmd === "clear" ||
    cmd === "cls" ||
    cmd === "quit" ||
    cmd === "q" ||
    cmd === "exit" ||
    cmd === "tools" ||
    cmd === "raw" ||
    cmd === "accounts" ||
    cmd === "scope" ||
    cmd === "switch" ||
    cmd === "sw"
  );
}

async function runRawCommand(args: string[]): Promise<void> {
  if (args.length < 1) {
    process.stderr.write("Usage: raw <toolName> [json-args]   e.g. raw health_check {}\n");
    return;
  }
  const [name, ...rest] = args;
  let parsed: unknown = {};
  if (rest.length > 0) {
    try {
      parsed = JSON.parse(rest.join(" "));
    } catch (err) {
      process.stderr.write(`Invalid JSON: ${(err as Error).message}\n`);
      return;
    }
  }
  await executeCliOp(name as string, parsed, { json: false });
}

async function listTools(): Promise<void> {
  // Tool metadata is static and does not require Gmail credentials.
  await import("../core/ops/index.js");
  const { registry } = await import("../core/registry.js");
  for (const name of registry.names().sort()) {
    process.stdout.write(`${name}\n`);
  }
}

async function listAccountsInSession(): Promise<void> {
  await executeCliOp("list_accounts", {}, { json: false });
}

async function switchAccountInSession(
  args: string[],
  setScope?: (scope: BrowseScope) => void,
): Promise<void> {
  const [accountId] = args;
  if (!accountId) {
    process.stderr.write("Usage: switch <accountId>   e.g. switch work\n");
    return;
  }
  const outcome = await executeCliOp("switch_account", { accountId }, { json: false });
  if (!outcome.isError) setScope?.({ kind: "single", accountId });
}

function scopeLabel(scope: BrowseScope): string {
  if (scope.kind === "all") return "all";
  if (scope.kind === "selected") return `selected:${scope.accountIds.join(",")}`;
  return scope.accountId ?? getCurrentAccountId() ?? "(none)";
}

function isCombinedScope(scope: BrowseScope): boolean {
  return scope.kind === "all" || scope.kind === "selected";
}

async function resolveScopeAccountIds(scope: BrowseScope): Promise<string[]> {
  if (scope.kind === "single") return scope.accountId ? [scope.accountId] : [];
  const accounts = await callOp<{ accounts: Array<{ id: string }> }>("list_accounts", {});
  if (scope.kind === "all") return accounts.accounts.map((a) => a.id);
  const valid = new Set(accounts.accounts.map((a) => a.id));
  return scope.accountIds.filter((id) => valid.has(id));
}

async function handleScopeCommand(
  args: string[],
  isTty: boolean,
  getScope: () => BrowseScope,
  setScope: (scope: BrowseScope) => void,
): Promise<void> {
  if (args.length === 0) {
    process.stdout.write(`Browse scope: ${scopeLabel(getScope())}\n`);
    return;
  }

  const [head, ...rest] = args;
  if (head === "all") {
    setScope({ kind: "all" });
    process.stdout.write("Browse scope: all accounts\n");
    return;
  }

  if (head === "select") {
    if (rest.length > 0) {
      setScope({ kind: "selected", accountIds: rest });
      process.stdout.write(`Browse scope: selected ${rest.join(", ")}\n`);
      return;
    }
    if (!isTty) {
      process.stderr.write("Usage: scope select <accountId...> in non-TTY mode\n");
      return;
    }
    const accounts = await callOp<{
      accounts: Array<{ id: string; emailAddress: string | null; isActive: boolean }>;
    }>("list_accounts", {});
    const { checkbox } = await import("@inquirer/prompts");
    const selected = (await checkbox({
      message: "Select accounts to browse",
      choices: accounts.accounts.map((a) => ({
        name: `${a.id}${a.emailAddress ? ` <${a.emailAddress}>` : ""}`,
        value: a.id,
        checked: a.isActive,
      })),
    })) as string[];
    setScope({ kind: "selected", accountIds: selected });
    process.stdout.write(`Browse scope: selected ${selected.join(", ")}\n`);
    return;
  }

  const singleMatch = /^single:(.+)$/.exec(head);
  if (singleMatch) {
    const accountId = singleMatch[1]!;
    const outcome = await executeCliOp("switch_account", { accountId }, { json: false });
    if (!outcome.isError) setScope({ kind: "single", accountId });
    return;
  }

  if (args.length === 1) {
    const outcome = await executeCliOp("switch_account", { accountId: head }, { json: false });
    if (!outcome.isError) setScope({ kind: "single", accountId: head });
    return;
  }

  setScope({ kind: "selected", accountIds: args });
  process.stdout.write(`Browse scope: selected ${args.join(", ")}\n`);
}

async function runCombinedReadCommand(
  scope: BrowseScope,
  resolvedCmd: string,
  args: string[],
): Promise<boolean> {
  if (!isCombinedScope(scope)) return false;
  if (resolvedCmd === "inbox") {
    const maxResults = parsePositiveIntArg(args) ?? 10;
    await printCombinedInbox(scope, { query: "in:inbox", maxResults });
    return true;
  }
  if (resolvedCmd === "search") {
    const query = args.filter((a) => !a.startsWith("-")).join(" ");
    if (!query) {
      process.stderr.write("Usage: search <query>\n");
      return true;
    }
    await printCombinedSearch(scope, { query, maxResults: 25 });
    return true;
  }
  if (resolvedCmd === "threads" && (args[0] === "list" || args[0] === "inbox")) {
    await printCombinedInbox(scope, { query: "in:inbox", maxResults: 25 });
    return true;
  }
  if (resolvedCmd === "threads" && args[0] === "get") {
    const threadId = args[1];
    if (!threadId) {
      process.stderr.write("Usage: threads get <threadId>\n");
      return true;
    }
    await printCombinedThread(scope, threadId);
    return true;
  }
  return false;
}

function parsePositiveIntArg(args: string[]): number | null {
  for (const arg of args) {
    const n = Number.parseInt(arg, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function printCombinedInbox(
  scope: BrowseScope,
  opts: { query: string; maxResults: number },
): Promise<void> {
  const rows: Array<{
    accountId: string;
    emailAddress: string | null;
    threadId: string;
    from: string;
    subject: string;
    date: string;
    messageCount: number;
  }> = [];
  const previous = getCurrentAccountId();
  const accounts = await callOp<{
    accounts: Array<{ id: string; emailAddress: string | null }>;
  }>("list_accounts", {});
  const emailById = new Map(accounts.accounts.map((a) => [a.id, a.emailAddress]));
  const ids = await resolveScopeAccountIds(scope);

  try {
    for (const accountId of ids) {
      await callOp("switch_account", { accountId });
      const inbox = await callOp<{
        threads: Array<{
          threadId: string;
          messageCount: number;
          latestMessage: { from: string; subject: string; date: string };
        }>;
      }>("list_inbox_threads", opts);
      for (const t of inbox.threads) {
        rows.push({
          accountId,
          emailAddress: emailById.get(accountId) ?? null,
          threadId: t.threadId,
          from: t.latestMessage.from,
          subject: t.latestMessage.subject,
          date: t.latestMessage.date,
          messageCount: t.messageCount,
        });
      }
    }
  } finally {
    if (previous && previous !== getCurrentAccountId()) {
      await callOp("switch_account", { accountId: previous }).catch(() => undefined);
    }
  }

  if (rows.length === 0) {
    process.stdout.write("(no threads)\n");
    return;
  }
  for (const row of rows) {
    const account = row.emailAddress ? `${row.accountId}<${row.emailAddress}>` : row.accountId;
    const count = row.messageCount > 1 ? ` (${row.messageCount})` : "";
    process.stdout.write(
      `[${account}] ${row.threadId}${count}\nSubject: ${row.subject}\nFrom: ${row.from}\nDate: ${row.date}\n\n`,
    );
  }
}

async function printCombinedSearch(
  scope: BrowseScope,
  opts: { query: string; maxResults: number },
): Promise<void> {
  const previous = getCurrentAccountId();
  const accounts = await callOp<{
    accounts: Array<{ id: string; emailAddress: string | null }>;
  }>("list_accounts", {});
  const emailById = new Map(accounts.accounts.map((a) => [a.id, a.emailAddress]));
  const ids = await resolveScopeAccountIds(scope);
  try {
    for (const accountId of ids) {
      await callOp("switch_account", { accountId });
      const result = await callOp<{
        results: Array<{ id: string | null; subject: string; from: string; date: string }>;
      }>("search_emails", opts);
      const email = emailById.get(accountId) ?? null;
      for (const r of result.results) {
        const account = email ? `${accountId}<${email}>` : accountId;
        process.stdout.write(
          `[${account}] ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n\n`,
        );
      }
    }
  } finally {
    if (previous && previous !== getCurrentAccountId()) {
      await callOp("switch_account", { accountId: previous }).catch(() => undefined);
    }
  }
}

async function printCombinedThread(scope: BrowseScope, rawThreadId: string): Promise<void> {
  const previous = getCurrentAccountId();
  const accounts = await callOp<{
    accounts: Array<{ id: string; emailAddress: string | null }>;
  }>("list_accounts", {});
  const emailById = new Map(accounts.accounts.map((a) => [a.id, a.emailAddress]));
  const prefixed = /^([^:]+):(.+)$/.exec(rawThreadId);
  const ids = prefixed ? [prefixed[1]!] : await resolveScopeAccountIds(scope);
  const threadId = prefixed ? prefixed[2]! : rawThreadId;
  let found = false;

  try {
    for (const accountId of ids) {
      try {
        await callOp("switch_account", { accountId });
        const result = (await callMcpTool("get_thread", {
          threadId,
          format: "full",
        })) as ToolResult;
        const email = emailById.get(accountId) ?? null;
        const account = email ? `${accountId}<${email}>` : accountId;
        process.stdout.write(`[${account}]\n${formatToolResultText(result)}\n\n`);
        found = true;
        if (prefixed) break;
      } catch {
        if (prefixed) throw new Error(`Thread ${threadId} not found in account ${accountId}`);
      }
    }
  } finally {
    if (previous && previous !== getCurrentAccountId()) {
      await callOp("switch_account", { accountId: previous }).catch(() => undefined);
    }
  }

  if (!found) process.stderr.write(`Thread ${threadId} not found in selected scope\n`);
}

// ── REPL entry ───────────────────────────────────────────────────────

export interface ConsoleOptions {
  /** Override the writer for the legend & prompt cues (used by tests). */
  write?: (s: string) => void;
}

/** Public entry point — used by the `gmail console` subcommand action. */
export async function runConsole(options: ConsoleOptions = {}): Promise<void> {
  const write = options.write ?? ((s: string) => process.stdout.write(`${s}\n`));
  printLegend(write);

  // Bootstrap eagerly so the first command isn't slow.
  try {
    await bootstrapForCli();
  } catch (err) {
    process.stderr.write(`Warning: bootstrap deferred — ${(err as Error).message}\n`);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });

  let scope: BrowseScope = { kind: "single", accountId: getCurrentAccountId() };
  const setScope = (next: BrowseScope) => {
    scope = next;
  };

  const promptStr = (): string => {
    return pc.cyan(`gmail[${scopeLabel(scope)}]> `);
  };

  // Track readline closure so `.finally(maybePrompt)` doesn't try to write
  // a new prompt after `exit` / `q` / EOF closed the interface (which would
  // throw ERR_USE_AFTER_CLOSE from inside readline.Interface.resume).
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  const maybePrompt = () => {
    if (closed) return;
    if (process.stdin.isTTY && typeof rl.prompt === "function") {
      rl.setPrompt?.(promptStr());
      rl.prompt();
    }
  };

  const processLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const { cmd, args } = parseConsoleInput(trimmed);
    const cmdLower = cmd.toLowerCase();

    // Built-in intercepts first — these don't go through commander.
    if (cmdLower === "help" || cmdLower === "?") {
      printLegend(write);
      return;
    }
    if (cmdLower === "clear" || cmdLower === "cls") {
      process.stdout.write("\x1b[2J\x1b[H");
      return;
    }
    if (cmdLower === "quit" || cmdLower === "q" || cmdLower === "exit") {
      rl.close();
      return;
    }
    if (cmdLower === "tools") {
      try {
        await listTools();
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
      }
      process.stdout.write("\n");
      return;
    }
    if (cmdLower === "raw") {
      try {
        await runRawCommand(args);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
      }
      process.stdout.write("\n");
      return;
    }
    if (cmdLower === "accounts") {
      process.stdout.write(`Browse scope: ${scopeLabel(scope)}\n`);
      try {
        await listAccountsInSession();
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
      }
      process.stdout.write("\n");
      return;
    }
    if (cmdLower === "scope") {
      try {
        await handleScopeCommand(args, process.stdin.isTTY === true, () => scope, setScope);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
      }
      process.stdout.write("\n");
      return;
    }
    if (cmdLower === "switch" || cmdLower === "sw") {
      try {
        await switchAccountInSession(args, setScope);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
      }
      process.stdout.write("\n");
      return;
    }

    // Route to commander. Rebuild the program per line so option defaults
    // don't leak between calls (Commander v14 caveat).
    const resolvedCmd = rewriteAlias(cmdLower);
    const handled = await runCombinedReadCommand(scope, resolvedCmd, args);
    if (handled) {
      process.stdout.write("\n");
      return;
    }
    const argv = ["node", "gmail", resolvedCmd, ...args];

    process.env.GMAIL_CLI_REPL = "1";
    try {
      const program = buildProgram();
      program.exitOverride(); // throw instead of process.exit on commander errors
      await program.parseAsync(argv);
    } catch (err) {
      const e = err as { code?: string; message?: string; replExit?: boolean };
      // `exitCli()` from runtime.ts throws this sentinel under GMAIL_CLI_REPL.
      // The handler has already written any diagnostic to stderr; we silently
      // swallow so the prompt cleanly returns. This is what unblocks `h`,
      // `account check`, etc. from killing the console.
      if (e.replExit === true) {
        // no-op
      } else if (e.code?.startsWith("commander.")) {
        // Help and version exits also come through here — those are not
        // errors. Quiet them unless they actually carry a message.
        // Commander also writes the same message to stderr itself; suppress
        // our duplicate "Error: …" line for unknownCommand/missingArgument
        // so the user sees one diagnostic, not two.
        if (
          e.code !== "commander.help" &&
          e.code !== "commander.helpDisplayed" &&
          e.code !== "commander.version" &&
          e.code !== "commander.unknownCommand" &&
          e.code !== "commander.unknownOption" &&
          e.code !== "commander.missingArgument" &&
          e.code !== "commander.excessArguments"
        ) {
          process.stderr.write(`Error: ${e.message ?? e.code}\n`);
        }
      } else {
        process.stderr.write(`Error: ${e?.message ?? String(err)}\n`);
      }
    } finally {
      delete process.env.GMAIL_CLI_REPL;
    }
    process.stdout.write("\n");
  };

  let lineQueue = Promise.resolve();
  rl.on("line", (line) => {
    lineQueue = lineQueue
      .then(() => processLine(line))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
      })
      .finally(maybePrompt);
  });
  rl.on("close", () => {
    // EOF/close is a normal console termination path. Do not process.exit()
    // here; callers/tests can own lifecycle and outstanding queued work.
  });
  maybePrompt();
}
