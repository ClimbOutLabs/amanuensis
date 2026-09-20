// `gmail-cli threads …` — list, get, modify, inbox.
//
// Pagination: `--max 0` / `--all` stream every page until exhausted OR
// PAGINATION_HARD_CAP. Ctrl-C cancels and prints partial output.

import { Command } from "commander";
import {
  exitCodeForError,
  installSigintAbort,
  PAGINATION_HARD_CAP,
  PAGINATION_MAX_PAGES,
  paginate,
  runCliOp,
} from "../runtime.js";

interface ThreadSummary {
  threadId: string;
  snippet: string;
  historyId: string;
  messageCount: number;
  latestMessage: { from: string; subject: string; date: string };
}

async function streamThreadList(options: {
  query?: string;
  max: number;
  json?: boolean;
}): Promise<void> {
  const { controller, restore } = installSigintAbort();
  try {
    const PAGE_SIZE = 100;
    const result = await paginate<
      { query?: string; maxResults: number; pageToken?: string },
      ThreadSummary
    >({
      toolName: "list_inbox_threads",
      pageSize: PAGE_SIZE,
      totalMax: options.max,
      argsForPage: (pageToken) => ({
        query: options.query,
        maxResults: PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      }),
      extract: (output) => {
        const o = output as {
          resultCount: number;
          threads: ThreadSummary[];
          nextPageToken?: string;
          resultSizeEstimate?: number;
        };
        return {
          items: o.threads,
          nextPageToken: o.nextPageToken,
          resultSizeEstimate: o.resultSizeEstimate,
        };
      },
      onPage: (page, accumulated) => {
        process.stderr.write(
          `… page ${Math.ceil(accumulated.length / PAGE_SIZE)}: +${page.items.length} (total ${accumulated.length}${page.resultSizeEstimate ? ` / ~${page.resultSizeEstimate}` : ""})\n`,
        );
      },
      signal: controller.signal,
    });

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            resultCount: result.items.length,
            threads: result.items,
            pageCount: result.pageCount,
            truncated: result.truncatedAtHardCap,
            hitPageCap: result.hitPageCap,
            repeatedPageToken: result.repeatedPageToken,
            resultSizeEstimate: result.resultSizeEstimate,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      for (const t of result.items) {
        process.stdout.write(
          `[${t.threadId}] (${t.messageCount}) ${t.latestMessage.from} — ${t.latestMessage.subject}  · ${t.latestMessage.date}\n`,
        );
      }
      process.stderr.write(
        `\n${result.items.length} thread(s) across ${result.pageCount} page(s)${result.exhausted ? " — exhausted" : ""}${result.truncatedAtHardCap ? ` — TRUNCATED at hard cap (${PAGINATION_HARD_CAP})` : ""}${result.hitPageCap ? ` — STOPPED at page cap (${PAGINATION_MAX_PAGES})` : ""}${result.repeatedPageToken ? " — STOPPED: server repeated a page token" : ""}\n`,
      );
    }
  } catch (err) {
    const e = err as Error;
    if (controller.signal.aborted) {
      process.stderr.write("\nCancelled (SIGINT) — partial output above.\n");
      process.exit(130);
    }
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(exitCodeForError(e));
  } finally {
    restore();
  }
}

export function buildThreadsCommand(): Command {
  const cmd = new Command("threads");
  cmd.description("Thread-level operations (groups of related messages)");

  cmd
    .command("list")
    .description("List inbox threads (Gmail query syntax via --query)")
    .option("-q, --query <q>", "Gmail search query (default: in:inbox)")
    .option(
      "-n, --max <n>",
      `Max results — 0 = stream all pages up to ${PAGINATION_HARD_CAP} (default: 25)`,
      (v) => Number.parseInt(v, 10),
      25,
    )
    .option("--all", "Stream every page (shorthand for --max 0)")
    .option("--json", "Emit typed JSON")
    .action(async (options: { query?: string; max?: number; all?: boolean; json?: boolean }) => {
      const max = options.all ? 0 : (options.max ?? 25);
      if (max > 0 && max <= 500) {
        await runCliOp(
          "list_inbox_threads",
          { query: options.query, maxResults: max },
          { json: options.json },
        );
        return;
      }
      await streamThreadList({ query: options.query, max, json: options.json });
    });

  cmd
    .command("get [threadId]")
    .description("Fetch a thread's messages (by thread id, or -m <messageId>)")
    .option("-m, --message-id <id>", "Resolve the thread from a message id instead of a thread id")
    .option("-f, --format <fmt>", "full | metadata | minimal (default: full)", "full")
    .option("--json", "Emit typed JSON")
    .action(
      async (
        threadId: string | undefined,
        options: {
          messageId?: string;
          format?: "full" | "metadata" | "minimal";
          json?: boolean;
        },
      ) => {
        if (Boolean(threadId) === Boolean(options.messageId)) {
          process.stderr.write("Error: provide exactly one of <threadId> or -m <messageId>\n");
          process.exit(3);
        }
        const idArgs = threadId ? { threadId } : { messageId: options.messageId };
        await runCliOp("get_thread", { ...idArgs, format: options.format }, { json: options.json });
      },
    );

  cmd
    .command("modify <threadId>")
    .description("Add/remove labels on every message in a thread")
    .option("--add <ids>", "Comma-separated label IDs to add")
    .option("--remove <ids>", "Comma-separated label IDs to remove")
    .option("--json", "Emit typed JSON")
    .action(
      async (threadId: string, options: { add?: string; remove?: string; json?: boolean }) => {
        await runCliOp(
          "modify_thread",
          {
            threadId,
            addLabelIds: options.add?.split(",").map((s) => s.trim()),
            removeLabelIds: options.remove?.split(",").map((s) => s.trim()),
          },
          { json: options.json },
        );
      },
    );

  cmd
    .command("inbox")
    .description("Get inbox threads with optional message-body expansion")
    .option("-q, --query <q>", "Gmail search query (default: in:inbox)")
    .option("-n, --max <n>", "Max threads (default: 25)", (v) => Number.parseInt(v, 10), 25)
    .option("-e, --expand", "Expand each thread with full message content")
    .option("--json", "Emit typed JSON")
    .action(async (options: { query?: string; max?: number; expand?: boolean; json?: boolean }) => {
      await runCliOp(
        "get_inbox_with_threads",
        {
          query: options.query,
          maxResults: options.max,
          expandThreads: options.expand ?? false,
        },
        { json: options.json },
      );
    });

  return cmd;
}

/**
 * Top-level `gmail-cli inbox` — friendly alias for `threads list` with sane
 * inbox defaults. The most common one-liner I'd want from a terminal.
 */
export function buildInboxAliasCommand(): Command {
  const cmd = new Command("inbox");
  cmd
    .description("Shortcut: list recent inbox threads (alias for `threads list -q in:inbox`)")
    .argument(
      "[max]",
      `Max threads — 0 = stream all up to ${PAGINATION_HARD_CAP} (default: 10)`,
      (v) => Number.parseInt(v, 10),
    )
    .option(
      "-n, --max <n>",
      `Max threads — 0 = stream all up to ${PAGINATION_HARD_CAP} (default: 10)`,
      (v) => Number.parseInt(v, 10),
    )
    .option("--all", "Stream every page (shorthand for max = 0)")
    .option("--json", "Emit typed JSON")
    .action(
      async (
        maxArg: number | undefined,
        options: { max?: number; all?: boolean; json?: boolean },
      ) => {
        const max = options.all ? 0 : (maxArg ?? options.max ?? 10);
        if (max > 0 && max <= 500) {
          await runCliOp(
            "list_inbox_threads",
            { query: "in:inbox", maxResults: max },
            { json: options.json },
          );
          return;
        }
        await streamThreadList({ query: "in:inbox", max, json: options.json });
      },
    );
  return cmd;
}
