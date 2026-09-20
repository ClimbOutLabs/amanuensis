// Runtime helpers shared by CLI subcommands that need to drive the MCP
// dispatcher in-process. Bootstraps via main({ skipTransport: true }) so we
// share the same credential loading + Gmail client + dispatcher closure as
// the MCP server, without installing a stdio/HTTP transport.

import fs from "node:fs";
import path from "node:path";
import { callMcpTool } from "../index.js";

let bootstrapped = false;

/**
 * Idempotent. First call loads credentials, builds the Gmail API client,
 * and exposes the dispatcher via callMcpTool. Subsequent calls are no-ops.
 *
 * Throws with a clear message if credentials are missing — callers should
 * surface that to the user with a hint to run `gmail account auth <id>`.
 */
export async function bootstrapForCli(): Promise<void> {
  if (bootstrapped) return;
  const indexModule = await import("../index.js");
  await indexModule.main({ skipTransport: true });
  bootstrapped = true;
}

export { callMcpTool } from "../index.js";

/**
 * Helper for `--body @file` / `--body -` (stdin) reading used by send-style
 * CLI subcommands. Centralized so every send/draft/reply-all command behaves
 * the same.
 */
export async function resolveBodyInput(raw: string | undefined): Promise<string | undefined> {
  if (raw === undefined) return undefined;
  if (raw === "-") {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on("data", (c) => chunks.push(c));
      process.stdin.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      process.stdin.on("error", reject);
    });
  }
  if (raw.startsWith("@")) {
    const filePath = path.resolve(raw.slice(1));
    return fs.readFileSync(filePath, "utf8");
  }
  return raw;
}

/**
 * Format an MCP tool result for terminal output. The MCP convention is
 * `content: [{type:"text", text:"..."}]`; we just join the text fragments.
 */
export function formatToolResultText(result: {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Generic exit-code mapper for CLI command errors. Returns 2 for auth /
 * credential issues (so scripts can branch on "needs re-auth"), 3 for usage
 * errors, 1 otherwise.
 */
export function exitCodeForError(err: Error): number {
  const msg = err.message ?? "";
  if (/credentials|invalid_grant|gmail account auth|gmail auth/i.test(msg)) return 2;
  if (/INVALID_SCOPE|invalid scope|usage/i.test(msg)) return 3;
  return 1;
}

/**
 * Print an MCP tool result to stdout in either JSON (typed structured
 * content preferred) or human-readable text mode. Centralised so every
 * subcommand emits consistent output and `--json` is always type-true JSON
 * rather than the legacy wrapped text envelope.
 */
export function printToolResult(
  result: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  },
  options: { json?: boolean } = {},
): void {
  if (options.json) {
    // Prefer the typed structured payload (Phase B2); fall back to the
    // text envelope wrapped as { text } so the consumer always gets valid
    // JSON to parse.
    const payload =
      result.structuredContent !== undefined
        ? result.structuredContent
        : { text: formatToolResultText(result) };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatToolResultText(result)}\n`);
  }
}

export interface ToolResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface CliOpOutcome {
  /** Raw MCP result when the dispatch completed (may still be isError). */
  result?: ToolResult;
  /** True when either the dispatcher returned isError or bootstrap threw. */
  isError: boolean;
  /** Set when bootstrap or dispatch threw (NOT for tool-level isError). */
  errorMessage?: string;
}

/**
 * REPL-safe op execution. Bootstraps the dispatcher (idempotent), runs the
 * tool, prints the formatted result, and returns the outcome. Never calls
 * process.exit — that's `runCliOp`'s job for CLI mode.
 *
 * Used directly by `src/cli/console.ts` so the interactive REPL doesn't
 * tear down the process after each command.
 */
export async function executeCliOp(
  toolName: string,
  args: unknown,
  options: { json?: boolean } = {},
): Promise<CliOpOutcome> {
  try {
    await bootstrapForCli();
    const result = (await callMcpTool(toolName, args)) as ToolResult;
    printToolResult(result, options);
    return { result, isError: result.isError === true };
  } catch (err) {
    const e = err as Error;
    process.stderr.write(`Error: ${e.message}\n`);
    return { isError: true, errorMessage: e.message };
  }
}

/**
 * Standard subcommand wrapper: bootstrap → run tool → print → exit with the
 * right code. Eliminates the boilerplate every per-op command would otherwise
 * repeat.
 *
 * In REPL mode (`process.env.GMAIL_CLI_REPL === "1"`), the exit is suppressed
 * so the interactive console loop continues. The console code is expected to
 * set + clear that env around each `program.parseAsync` call.
 */
export async function runCliOp(
  toolName: string,
  args: unknown,
  options: { json?: boolean } = {},
): Promise<void> {
  const outcome = await executeCliOp(toolName, args, options);
  if (process.env.GMAIL_CLI_REPL === "1") {
    // REPL mode — return control to the console loop. The console renders
    // its own prompt cue; we deliberately do not exit.
    return;
  }
  if (outcome.errorMessage) {
    process.exit(exitCodeForError(new Error(outcome.errorMessage)));
  }
  process.exit(outcome.isError ? 1 : 0);
}

/**
 * REPL-aware replacement for `process.exit(code)` inside commander
 * subcommand action handlers. In REPL mode (`GMAIL_CLI_REPL=1`) it throws a
 * sentinel so commander's `parseAsync` rejects and the console's catch
 * keeps the REPL alive. In CLI mode it terminates the process as before.
 *
 * Why this exists: handlers that called `process.exit` directly (e.g.
 * `health`, `account`, `send` usage errors) killed the entire console when
 * invoked from `gmail console`. `runCliOp` already guards its own exits,
 * but handlers that bypass `runCliOp` (synchronous local commands, error
 * branches that exit before dispatching) need this helper.
 *
 * The thrown error message is intentionally empty — the diagnostic has
 * already been written to stderr by the handler before the exit, so the
 * console catch shouldn't double-print. The `replExit` tag lets callers
 * distinguish "REPL exit cue" from real exceptions if they care.
 */
export function exitCli(code: number): never {
  if (process.env.GMAIL_CLI_REPL === "1") {
    const e = new Error("") as Error & { exitCode: number; replExit: true };
    e.exitCode = code;
    e.replExit = true;
    throw e;
  }
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Typed in-process op invocation (Pre-TUI Step 2)
// ---------------------------------------------------------------------------

/**
 * Thrown by `callOp` when the dispatcher returns an `isError: true` envelope.
 * Distinguishes tool-level failures (which include their own diagnostic text)
 * from infrastructure errors (which throw the underlying exception directly).
 */
export class ToolCallError extends Error {
  constructor(
    public toolName: string,
    message: string,
    public mcpResult?: ToolResult,
  ) {
    super(message);
    this.name = "ToolCallError";
  }
}

/**
 * Typed in-process dispatch. Bootstraps the server (idempotent), dispatches
 * the tool, returns its structured payload. Throws `ToolCallError` if the
 * tool returned `isError: true`; bubbles any infrastructure error otherwise.
 *
 * Designed for long-lived embedders (the TUI hooks in particular) that want
 * a Promise<TOutput> instead of the legacy MCP envelope. CLI commands keep
 * using `runCliOp`; `callOp` is additive.
 *
 * Type parameter is unchecked at runtime — callers annotate with the op's
 * `outputSchema` inferred type, e.g.
 *   const data = await callOp<z.infer<typeof ListInboxThreadsOutputSchema>>(
 *     "list_inbox_threads",
 *     { maxResults: 25 },
 *   );
 */
export async function callOp<TOutput = unknown>(
  toolName: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<TOutput> {
  await bootstrapForCli();
  const result = (await callMcpTool(toolName, args, signal)) as ToolResult;
  if (result.isError === true) {
    throw new ToolCallError(toolName, formatToolResultText(result), result);
  }
  return result.structuredContent as TOutput;
}

// ---------------------------------------------------------------------------
// Streaming pagination helper for `--max 0` / `--all` CLI flows
// ---------------------------------------------------------------------------

interface PaginatedPage<Item> {
  /** Per-page items. */
  items: Item[];
  /** Continuation token from the Gmail response. Empty/undefined → exhausted. */
  nextPageToken?: string;
  /** Gmail's server-side total estimate, surfaced from the first page. */
  resultSizeEstimate?: number;
}

interface PaginateOptions<Args, Item> {
  /** Op to call (must accept maxResults + pageToken inputs). */
  toolName: string;
  /** Per-page max — caller picks an appropriate page size (100 keeps the
      metadata.get fan-out latency reasonable). */
  pageSize: number;
  /** Total cap. `0` means stream every page until Gmail says we're done.
      Hard absolute cap of 5000 still applies as a safety net so a runaway
      query can't OOM the process. */
  totalMax: number;
  /** Builds the args object for each page. The function receives the
      current pageToken (empty for the first page) and returns the args
      object passed to the tool. */
  argsForPage: (pageToken: string | undefined) => Args;
  /** Picks the page payload off the typed structured output. */
  extract: (output: unknown) => PaginatedPage<Item>;
  /** Per-page callback. Returns false to stop pagination (e.g. user typed
      Ctrl-C and the caller wants to bail). */
  onPage?: (page: PaginatedPage<Item>, accumulated: Item[]) => void | Promise<void> | boolean;
  signal?: AbortSignal;
}

/** Defensive absolute ceiling — even with `--all`, we won't sweep more than
    this many items in one CLI invocation. Adjust if a real workflow needs
    more; the existing per-op timeout still protects each page. */
export const PAGINATION_HARD_CAP = 5000;

/**
 * Absolute ceiling on pages fetched in one paginate() run. Backstop for a
 * pageToken sequence that never terminates (server bug, proxy weirdness, or
 * a token cycle the seen-token check somehow misses). With the default page
 * size of 100 this allows up to 10,000 items — twice the item hard cap — so
 * it only ever fires on pathological pagination.
 */
export const PAGINATION_MAX_PAGES = 100;

/**
 * Loop tool calls with pageToken, accumulate results, honour Ctrl-C.
 *
 * The caller passes `--max N` from their command's option set; we translate:
 *   N === 0  → stream until Gmail returns no nextPageToken or PAGINATION_HARD_CAP hits.
 *   N  >  0  → stop once `accumulated.length >= N`.
 *
 * Returns the merged list AND the last page's metadata so the caller can
 * surface "estimated total" / "truncated" to the user.
 */
export async function paginate<Args, Item>(
  opts: PaginateOptions<Args, Item>,
): Promise<{
  items: Item[];
  pageCount: number;
  truncatedAtHardCap: boolean;
  hitTotalMax: boolean;
  hitPageCap: boolean;
  repeatedPageToken: boolean;
  exhausted: boolean;
  resultSizeEstimate?: number;
}> {
  await bootstrapForCli();
  const items: Item[] = [];
  let pageToken: string | undefined;
  let pageCount = 0;
  let resultSizeEstimate: number | undefined;
  // Tokens already consumed. Gmail pageTokens are opaque; if one repeats we
  // are cycling and would loop forever — bail out instead.
  const seenTokens = new Set<string>();
  const effectiveMax = opts.totalMax === 0 ? PAGINATION_HARD_CAP : opts.totalMax;
  const finish = (
    overrides: Partial<{
      items: Item[];
      truncatedAtHardCap: boolean;
      hitTotalMax: boolean;
      hitPageCap: boolean;
      repeatedPageToken: boolean;
      exhausted: boolean;
    }> = {},
  ) => ({
    items: overrides.items ?? items,
    pageCount,
    truncatedAtHardCap: false,
    hitTotalMax: false,
    hitPageCap: false,
    repeatedPageToken: false,
    exhausted: false,
    resultSizeEstimate,
    ...overrides,
  });
  while (true) {
    if (opts.signal?.aborted) break;
    if (pageCount >= PAGINATION_MAX_PAGES) {
      return finish({ hitPageCap: true });
    }
    const args = opts.argsForPage(pageToken);
    const result = (await callMcpTool(opts.toolName, args, opts.signal)) as ToolResult;
    if (result.isError === true) {
      throw new ToolCallError(opts.toolName, formatToolResultText(result), result);
    }
    pageCount += 1;
    const page = opts.extract(result.structuredContent);
    if (resultSizeEstimate === undefined && typeof page.resultSizeEstimate === "number") {
      resultSizeEstimate = page.resultSizeEstimate;
    }
    items.push(...page.items);
    if (opts.onPage) {
      const cont = await opts.onPage(page, items);
      if (cont === false) {
        return finish({
          items: items.slice(0, opts.totalMax === 0 ? items.length : opts.totalMax),
        });
      }
    }
    if (!page.nextPageToken) {
      return finish({ exhausted: true });
    }
    if (seenTokens.has(page.nextPageToken)) {
      // Token cycle — the server is replaying a page; stop instead of
      // spinning until a cap.
      return finish({ repeatedPageToken: true });
    }
    seenTokens.add(page.nextPageToken);
    if (items.length >= effectiveMax) {
      const truncatedAtHardCap = opts.totalMax === 0 && items.length >= PAGINATION_HARD_CAP;
      return finish({
        items: items.slice(0, opts.totalMax === 0 ? items.length : opts.totalMax),
        truncatedAtHardCap,
        hitTotalMax: opts.totalMax > 0,
      });
    }
    pageToken = page.nextPageToken;
  }
  return finish();
}

/**
 * Install a one-shot SIGINT handler that aborts an AbortController. Returns
 * the controller plus a cleanup function. Wire into CLI streaming flows so
 * Ctrl-C cancels the in-flight call AND prints whatever was accumulated up
 * to that point instead of half-state.
 */
export function installSigintAbort(): { controller: AbortController; restore: () => void } {
  const controller = new AbortController();
  const handler = () => {
    controller.abort();
    // Restore default so a second Ctrl-C kills the process if the user is
    // impatient with the cleanup.
    process.off("SIGINT", handler);
  };
  process.on("SIGINT", handler);
  return {
    controller,
    restore: () => process.off("SIGINT", handler),
  };
}
