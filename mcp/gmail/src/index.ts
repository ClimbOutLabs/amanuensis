// MCP server orchestrator.
//
// `gmail mcp` (and `gmail mcp --http`) routes here via the commander tree in
// src/cli/index.ts. The CLI commands also reach `callMcpTool` in-process via
// the runtime helper in src/cli/runtime.ts.
//
// Heavy lifting lives in:
//   - src/core/                — credentials, config paths, session state,
//                                registry, per-tool op handlers
//   - src/server/build.ts      — MCP Server factory + dispatcher closure
//   - src/server/http.ts       — Streamable HTTP transport (Phase G)
//   - src/cli/commands/auth.ts — OAuth flow
//
// Public entry points:
//   - `main(opts)`            — process-level entry. Installs watchdog +
//                                signal handlers, calls bootstrapSession, hooks
//                                up the transport. Exits the process on any
//                                bootstrap error (CLI/MCP semantics).
//   - `bootstrapSession(opts)` — pure orchestration. Loads credentials,
//                                builds the server + dispatcher, returns a
//                                SessionBundle. Throws BootstrapError instead
//                                of calling shutdown(). Designed for the TUI
//                                and any other long-lived embedder that wants
//                                to render its own error UI on failure.
//   - `callMcpTool`           — in-process dispatcher access. Initialised by
//                                main() OR bootstrapSession().

import fs from "node:fs";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import { AccountGmailError, buildAccountGmail } from "./core/account-gmail.js";
import { getAccountCredentialsPath, resolveActiveAccount } from "./core/accounts.js";
import { getCredentialsPath } from "./core/config-paths.js";
// Side-effect import: each op file under core/ops/ registers itself with
// the registry at module load time. Adding an import here exposes the op
// to the dispatcher constructed by server/build.ts.
import "./core/ops/index.js";
import {
  enableOrphanWatchdog,
  enableStdinEofDetection,
  getShutdownCause,
  installShutdownHandlers,
  installWatchdog,
  info as logInfo,
  logShutdown,
  logStartup,
  warn as logWarn,
  registerCleanup,
  setLogFilePrefix,
  shutdown,
  startHeapMonitor,
} from "@george43g/robustness";
import { getRecentErrorCount, getToolCallCount, setSession } from "./core/session.js";
import { READONLY_FALLBACK_SCOPES, wideScopeNotice } from "./scopes.js";
import { buildMcpServer, type CallToolFn } from "./server/build.js";
import { resolveToolPrefix } from "./server/tool-prefix.js";

// Preserve the pre-package log-naming contract: NDJSON files land in
// $TMPDIR/gmail-mcp/ as gmail-mcp-<pid>-<ts>.ndjson (the package default
// prefix is "mcp"). Module-level so every surface that imports this
// orchestrator inherits it before the first log line.
setLogFilePrefix("gmail-mcp");

// In-process dispatcher reference. Populated by `bootstrapSession()` after
// session initialisation so non-stdio callers (CLI / TUI / HTTP wrapper) can
// call tool handlers directly without going through a transport.
let _dispatcherFn: CallToolFn | null = null;

/**
 * Call a tool by name with structured arguments, in-process. Throws if
 * bootstrap hasn't completed yet — credentials / Gmail client / dispatcher
 * are all initialised together.
 */
export async function callMcpTool(
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<ReturnType<CallToolFn>> {
  if (!_dispatcherFn) {
    throw new Error(
      "callMcpTool: dispatcher not initialised — call main() or bootstrapSession() first.",
    );
  }
  return _dispatcherFn(name, args, signal);
}

// ---------------------------------------------------------------------------
// Embeddable bootstrap (used by main() and by the TUI)
// ---------------------------------------------------------------------------

/**
 * Typed error thrown by bootstrapSession when credential loading fails in a
 * way the caller needs to surface to the user (bad keys, malformed credentials
 * file, etc.). `main()` catches this and exits(1) — the TUI catches it and
 * renders a "credentials missing" pane instead. The `stage` field tells the
 * caller which step failed (useful for actionable error messages).
 */
export class BootstrapError extends Error {
  constructor(
    message: string,
    public stage: "oauth-keys" | "credentials" | "unknown",
    public override cause?: unknown,
  ) {
    super(message);
    this.name = "BootstrapError";
  }
}

export interface BootstrapOptions {
  /** When true, build the dispatcher but don't install any transport. Used by the CLI runtime + TUI. */
  skipTransport?: boolean;
  /** Override env (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface SessionBundle {
  oauth2Client: OAuth2Client;
  gmail: gmail_v1.Gmail;
  authorizedScopes: string[];
  accountId: string | null;
  server: Server;
  dispatch: CallToolFn;
}

/**
 * Pure bootstrap: load credentials, build the dispatcher, return a typed
 * bundle. Does NOT install signal handlers, watchdog, or any transport — that
 * stays in `main()` for the CLI/MCP path. Long-lived embedders (TUI) call
 * this directly and own their own lifecycle.
 *
 * Throws `BootstrapError` on failure; never calls `process.exit` / `shutdown`.
 */
export async function bootstrapSession(opts: BootstrapOptions = {}): Promise<SessionBundle> {
  const env = opts.env ?? process.env;

  // Fixture-mode short-circuit: skip OAuth entirely and back the session
  // with a JSON-driven fake gmail client. Used by `pnpm test:e2e` and by
  // `GMAIL_FIXTURE_MODE=1 pnpm dev:tui` for iterating on UI without real
  // credentials. The oauth2Client is stubbed to throw if any of its methods
  // are invoked — production code paths must NOT depend on it under fixture
  // mode (the fake gmail client serves every read; mutating calls return
  // canned success envelopes).
  if (env.GMAIL_FIXTURE_MODE === "1") {
    const fixtureDir = env.GMAIL_FIXTURE_DIR ?? "./fixtures/gmail";
    const accountIdFromEnv = env.GMAIL_ACCOUNT?.trim() || null;
    const { loadFixtureGmail, ensureFixtureConfigDir } = await import("./fixtures/loader.js");
    // Isolate the config dir so list_accounts / account manifest reads never
    // leak the real ~/.gmail-mcp/accounts.json into fixture-mode sessions.
    // Honours an explicit GMAIL_CONFIG_DIR if the caller set one (e.g. the
    // e2e suite uses .test-config); otherwise builds a per-process temp dir
    // seeded with fixture-derived account metadata.
    const configDir = ensureFixtureConfigDir(fixtureDir, env);
    process.env.GMAIL_CONFIG_DIR = configDir;
    const bundle = loadFixtureGmail(fixtureDir, accountIdFromEnv);
    logInfo("fixture mode", {
      accountDir: bundle.accountDir,
      scopes: bundle.scopes,
      configDir,
    });

    const stubOAuth = new Proxy({} as OAuth2Client, {
      get: () => {
        throw new Error(
          "OAuth2Client is stubbed in fixture mode — production code MUST NOT depend on it.",
        );
      },
    });

    setSession({
      oauth2Client: stubOAuth,
      gmail: bundle.gmail,
      authorizedScopes: bundle.scopes,
      accountId: accountIdFromEnv,
    });

    const { server, dispatch } = buildMcpServer({
      toolPrefix: resolveToolPrefix(process.argv.slice(2), env),
    });
    _dispatcherFn = dispatch;
    void opts.skipTransport;

    return {
      oauth2Client: stubOAuth,
      gmail: bundle.gmail,
      authorizedScopes: bundle.scopes,
      accountId: accountIdFromEnv,
      server,
      dispatch,
    };
  }

  // Resolve the active account using the M1 precedence chain. Returns
  // legacy-implicit "default" for unmigrated single-account users (which
  // triggers the credentials.json → accounts/default/ copy on first read).
  // Env-driven credentials (GMAIL_CREDENTIALS_JSON / _OP) keep working because
  // the loader chain short-circuits on env before consulting the account id.
  const active = resolveActiveAccount({ env });
  const accountId = active.id ?? undefined;
  logInfo("active account", { account: accountId ?? null, source: active.source });

  const credentialsPath = getCredentialsPath(env);

  // Build the active-account handle via the shared factory. requireCredentials:
  // false → a missing credentials file is tolerated (first-time `gmail account
  // auth` needs a client before tokens exist); any other loader failure throws
  // an AccountGmailError whose stage we map onto BootstrapError so the TUI can
  // render a stage-specific message.
  let bundle: Awaited<ReturnType<typeof buildAccountGmail>>;
  try {
    bundle = await buildAccountGmail(accountId ?? null, {
      env,
      fallbackPath: credentialsPath,
      requireCredentials: false,
      onPersistError: (error) => {
        logWarn("failed to persist refreshed OAuth tokens", { error: error.message });
      },
    });
  } catch (err) {
    if (err instanceof AccountGmailError) {
      throw new BootstrapError(
        err.message,
        err.stage === "oauth-keys" ? "oauth-keys" : "credentials",
        err.cause,
      );
    }
    throw new BootstrapError((err as Error).message, "unknown", err);
  }

  const { oauth2Client, gmail } = bundle;
  // Scopes: honour the stored list (even an explicit empty []); fall back to
  // the read-only list when credentials were absent or carried no scope list —
  // a missing list must never grant write access by default.
  const authorizedScopes = bundle.loaded?.credentials.scopes ?? READONLY_FALLBACK_SCOPES;

  // Warn when a legacy <configDir>/credentials.json shadows a per-account file
  // the user is no longer reading from. Common after migrating from single- to
  // multi-account: the legacy file lingers. Surfacing it lets the user delete
  // it; not fatal.
  if (accountId && bundle.loaded?.source === "file") {
    const perAccountPath = getAccountCredentialsPath(accountId, env);
    if (bundle.loaded.locator === perAccountPath && fs.existsSync(credentialsPath)) {
      logWarn("legacy credentials.json shadowed by per-account file", {
        legacy: credentialsPath,
        perAccount: perAccountPath,
        account: accountId,
      });
    }
  }

  const scopeNotice = wideScopeNotice({ scopes: authorizedScopes, accountId: accountId ?? null });
  if (scopeNotice) logWarn(scopeNotice);

  setSession({
    oauth2Client,
    gmail,
    authorizedScopes,
    accountId: accountId ?? null,
    scopeNotice,
  });

  const { server, dispatch } = buildMcpServer({
    toolPrefix: resolveToolPrefix(process.argv.slice(2), env),
  });
  _dispatcherFn = dispatch;

  // skipTransport is honoured here as a no-op (no transport install at this
  // layer anyway) — it's a hint for main() to short-circuit before connecting
  // stdio/HTTP, kept on the options for API parity with the legacy main() arg.
  void opts.skipTransport;

  return { oauth2Client, gmail, authorizedScopes, accountId: accountId ?? null, server, dispatch };
}

// ---------------------------------------------------------------------------
// Process-level entry (CLI / `gmail mcp` / `gmail mcp --http`)
// ---------------------------------------------------------------------------

/**
 * Process-level entry. Installs the watchdog + signal handlers (one-shot),
 * runs `bootstrapSession`, hooks up the transport, and exits on bootstrap
 * failure with a clear message.
 *
 * `skipTransport: true` runs the full bootstrap (credentials + Gmail client +
 * dispatcher) but does NOT install stdio or HTTP transport — used by the CLI
 * runtime to reach callMcpTool in-process without becoming an MCP server.
 */
export async function main(opts: { skipTransport?: boolean } = {}) {
  if (opts.skipTransport) {
    return await bootstrapSession({ skipTransport: true });
  }

  installShutdownHandlers();
  let shutdownLogged = false;
  registerCleanup(() => {
    // The shutdown controller's exit listener sweeps the whole cleanup
    // registry synchronously after the async pass, so an unguarded write here
    // lands the `shutdown` marker twice whenever a later cleanup stalls — and
    // the NDJSON post-mortem contract ("no shutdown entry = crash") needs
    // exactly one.
    if (shutdownLogged) return;
    shutdownLogged = true;
    logShutdown(getShutdownCause());
  });
  startHeapMonitor();
  installWatchdog();
  logStartup("gmail-mcp");

  let bundle: SessionBundle;
  try {
    bundle = await bootstrapSession();
  } catch (err) {
    if (err instanceof BootstrapError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error("Error during bootstrap:", err);
    }
    await shutdown(1);
    return;
  }

  const { server } = bundle;

  // Transport selection: --http switches to Streamable HTTP (Phase G).
  if (process.argv.includes("--http")) {
    const port = parseIntFlag("--port", 8080);
    const bind = parseStringFlag("--bind", "127.0.0.1");
    const tokenEnv = parseStringFlag("--token-env", "GMAIL_HTTP_TOKEN");
    const { startHttpServer } = await import("./server/http.js");
    // NOTE: the HTTP transport builds a fresh Server per MCP session via
    // buildMcpServer() (per-session isolation); no shared server is passed.
    await startHttpServer({
      port,
      bind,
      tokenEnv,
      // HTTP sessions must honour the same tool-name prefix as stdio mode
      // (--tool-prefix flag or GMAIL_MCP_TOOL_PREFIX env).
      toolPrefix: resolveToolPrefix(process.argv.slice(2), process.env),
      getCounters: () => ({
        toolCalls: getToolCallCount(),
        recentErrors: getRecentErrorCount(),
      }),
      log: (line) => {
        logInfo("http", { line });
        process.stderr.write(`${line}\n`);
      },
    });
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  enableStdinEofDetection();
  enableOrphanWatchdog();
}

function parseIntFlag(flag: string, fallback: number): number {
  const arg = process.argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (!arg) return fallback;
  if (arg === flag) {
    const idx = process.argv.indexOf(flag);
    const next = process.argv[idx + 1];
    const n = next !== undefined ? Number.parseInt(next, 10) : Number.NaN;
    return Number.isFinite(n) ? n : fallback;
  }
  const n = Number.parseInt(arg.slice(flag.length + 1), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseStringFlag(flag: string, fallback: string): string {
  const arg = process.argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (!arg) return fallback;
  if (arg === flag) {
    const idx = process.argv.indexOf(flag);
    return process.argv[idx + 1] ?? fallback;
  }
  return arg.slice(flag.length + 1) || fallback;
}

// Exported for tests — lets a test reset the in-process dispatcher between cases.
export function _resetDispatcherForTests(): void {
  _dispatcherFn = null;
}
