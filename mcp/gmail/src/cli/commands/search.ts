// `gmail-cli search <query> [-n N] [--json] [--all]`
//
// Search emails. Output is the typed SearchEmailsOutput shape under --json
// (Phase B2) or the human-readable text otherwise.
//
// Pagination: `--max 0` and `--all` stream every page until Gmail says
// we're done OR the hard cap kicks in (see PAGINATION_HARD_CAP). Ctrl-C
// cancels the in-flight call and prints whatever was accumulated.

import { Command } from "commander";
import {
  exitCodeForError,
  installSigintAbort,
  PAGINATION_HARD_CAP,
  PAGINATION_MAX_PAGES,
  paginate,
  runCliOp,
} from "../runtime.js";

export interface SearchCommandOptions {
  max?: number;
  all?: boolean;
  json?: boolean;
}

interface SearchItem {
  id: string | null;
  subject: string;
  from: string;
  date: string;
}

export function buildSearchCommand(): Command {
  const cmd = new Command("search");
  cmd
    .description("Search emails (Gmail query syntax — e.g. 'from:foo newer_than:7d')")
    .argument("<query>", "Gmail search query")
    .option(
      "-n, --max <n>",
      `Max results — 0 = stream all pages up to ${PAGINATION_HARD_CAP} (default: 25)`,
      (v) => Number.parseInt(v, 10),
      25,
    )
    .option("--all", "Stream every page (shorthand for --max 0)")
    .option("--json", "Emit typed JSON instead of human text")
    .action(async (query: string, options: SearchCommandOptions) => {
      const max = options.all ? 0 : (options.max ?? 25);
      // Single-page path: keep the existing simple runCliOp behaviour.
      // Anything that requires pagination (max=0 or > one page worth) goes
      // through the streaming helper.
      if (max > 0 && max <= 500) {
        await runCliOp("search_emails", { query, maxResults: max }, { json: options.json });
        return;
      }
      const { controller, restore } = installSigintAbort();
      try {
        const PAGE_SIZE = 100;
        const result = await paginate<
          { query: string; maxResults: number; pageToken?: string },
          SearchItem
        >({
          toolName: "search_emails",
          pageSize: PAGE_SIZE,
          totalMax: max,
          argsForPage: (pageToken) => ({
            query,
            maxResults: PAGE_SIZE,
            ...(pageToken ? { pageToken } : {}),
          }),
          extract: (output) => {
            const o = output as {
              resultCount: number;
              results: SearchItem[];
              nextPageToken?: string;
              resultSizeEstimate?: number;
            };
            return {
              items: o.results,
              nextPageToken: o.nextPageToken,
              resultSizeEstimate: o.resultSizeEstimate,
            };
          },
          onPage: (page, accumulated) => {
            // Per-page status to stderr so JSON mode's stdout stays clean.
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
                results: result.items,
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
          for (const r of result.items) {
            process.stdout.write(
              `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n\n`,
            );
          }
          process.stderr.write(
            `\n${result.items.length} result(s) across ${result.pageCount} page(s)${result.exhausted ? " — exhausted" : ""}${result.truncatedAtHardCap ? ` — TRUNCATED at hard cap (${PAGINATION_HARD_CAP})` : ""}${result.hitPageCap ? ` — STOPPED at page cap (${PAGINATION_MAX_PAGES})` : ""}${result.repeatedPageToken ? " — STOPPED: server repeated a page token" : ""}\n`,
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
    });
  return cmd;
}
