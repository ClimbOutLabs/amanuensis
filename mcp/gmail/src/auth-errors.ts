import { error as logError, info as logInfo } from "@george43g/robustness";
import type { OAuth2Client } from "google-auth-library";
import { getCurrentAccountId } from "./core/session.js";

/**
 * Detects Gmail / OAuth auth failures, attempts a token refresh on
 * `invalid_grant` (in case the access_token expired and the refresh_token is
 * still valid), and returns an MCP-friendly error response with a remediation
 * hint pointing the user at `gmail account auth`.
 *
 * Refresh attempts are tracked per account with a cooldown window (not a
 * process-global one-shot latch): a failing account doesn't block refresh for
 * other accounts, and a transient blip doesn't permanently disable refresh
 * for the server's lifetime. After a successful refresh the dispatcher retries
 * the failed operation once (see server/build.ts).
 */

const REFRESH_COOLDOWN_MS = 60_000;
/** accountId (or "default") -> timestamp of the last refresh attempt. */
const refreshAttemptedAt = new Map<string, number>();

export interface MCPErrorResponse {
  isError: true;
  content: { type: "text"; text: string }[];
}

/**
 * True for Google's rate-limit 403s (rateLimitExceeded /
 * userRateLimitExceeded / quotaExceeded). These are quota signals, not
 * authentication failures, and must never be classified as auth errors
 * (which would point the user at re-auth instead of backing off).
 */
export function isRateLimit403(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: number | string;
    status?: number;
    message?: string;
    errors?: Array<{ reason?: string }>;
    response?: { status?: number; data?: { error?: { errors?: Array<{ reason?: string }> } } };
  };
  const code = e.code ?? e.status ?? e.response?.status;
  if (code !== 403 && code !== "403") return false;
  const reasons: Array<string | undefined> = [
    ...(e.errors ?? []).map((x) => x?.reason),
    ...(e.response?.data?.error?.errors ?? []).map((x) => x?.reason),
  ];
  if (reasons.some((r) => typeof r === "string" && r.toLowerCase().includes("ratelimit")))
    return true;
  if (reasons.some((r) => typeof r === "string" && r.toLowerCase().includes("quotaexceeded")))
    return true;
  const msg = (e.message ?? "").toLowerCase();
  return msg.includes("rate limit exceeded") || msg.includes("quota exceeded");
}

export function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: string; code?: number | string; status?: number };
  const msg = (e.message ?? "").toLowerCase();
  if (msg.includes("invalid_grant") || msg.includes("invalid grant")) return true;
  if (msg.includes("invalid credentials")) return true;
  if (e.code === 401 || e.status === 401) return true;
  // 403 is only an auth signal when it is NOT a rate-limit/quota 403.
  if ((e.code === 403 || e.status === 403) && !isRateLimit403(err)) return true;
  if (msg.includes("unauthorized")) return true;
  return false;
}

/**
 * Detects Gmail API 404s, which arrive as either `err.code === 404`,
 * `err.status === 404`, or `err.errors?.[0]?.reason === "notFound"`. Used to
 * rewrap "entity not found" with the active account id so callers (humans
 * and sub-agents) can self-diagnose IDs pasted from the wrong mailbox.
 */
export function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: number | string;
    status?: number;
    message?: string;
    errors?: Array<{ reason?: string }>;
  };
  if (e.code === 404 || e.status === 404) return true;
  if (typeof e.code === "string" && e.code === "404") return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => x?.reason === "notFound")) return true;
  // googleapis surfaces a bare "Not Found" message for some operations.
  const msg = (e.message ?? "").toLowerCase();
  if (msg === "not found" || msg.startsWith("not found")) return true;
  return false;
}

function isInvalidGrant(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = ((err as { message?: string }).message ?? "").toLowerCase();
  return msg.includes("invalid_grant") || msg.includes("invalid grant");
}

/**
 * Attempt a token refresh for an auth failure, subject to the per-account
 * cooldown. Returns true when the refresh produced a new access_token — the
 * caller should then retry the failed operation once.
 *
 * Only attempted for `invalid_grant` failures (expired access token with a
 * still-valid refresh token). Other auth failures (revoked grants, bad
 * credentials) cannot be fixed by refreshing and go straight to the re-auth
 * hint.
 */
export async function tryRefreshForAuthError(
  err: unknown,
  client: OAuth2Client | null,
): Promise<boolean> {
  if (!client || !isInvalidGrant(err)) return false;
  const accountId = getCurrentAccountId();
  const key = accountId ?? "default";
  const now = Date.now();
  const lastAttempt = refreshAttemptedAt.get(key) ?? 0;
  if (now - lastAttempt < REFRESH_COOLDOWN_MS) {
    logInfo("oauth_refresh_skipped_cooldown", { account: key });
    return false;
  }
  refreshAttemptedAt.set(key, now);
  try {
    const result = await client.getAccessToken();
    if (result?.token) {
      logInfo("oauth_refresh_attempt", { success: true, account: key });
      return true;
    }
  } catch (e) {
    logError("oauth_refresh_attempt", {
      success: false,
      account: key,
      message: (e as Error)?.message,
    });
  }
  return false;
}

/**
 * Wrap an arbitrary error from a tool dispatch into an MCP error response.
 * - Auth errors get tool context + remediation hint.
 * - Other errors get tool context.
 *
 * Token refresh + one retry of the failed operation is orchestrated by the
 * dispatcher (server/build.ts) via tryRefreshForAuthError, not here, so the
 * retry can re-enter the dispatch path.
 */
export async function wrapToolError(
  err: unknown,
  toolName: string,
  _oauth2Client: OAuth2Client | null,
): Promise<MCPErrorResponse> {
  const message = (err instanceof Error ? err.message : String(err)) || "unknown error";

  if (isAuthError(err)) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `${toolName} failed: ${message} — ${formatReauthHint()}`,
        },
      ],
    };
  }

  // 404s are particularly confusing without account context: a message or
  // thread id valid in account A returns bare "Not Found" when the active
  // session is on account B. Surface the active account so the user (or a
  // sub-agent) knows where the lookup was scoped and how to switch. For
  // thread-specific tools we also flag the common messageId-vs-threadId
  // mix-up — `read_email` returns a `threadId` field that callers should
  // use here.
  if (isNotFoundError(err)) {
    const accountId = getCurrentAccountId();
    const scope = accountId ? `account "${accountId}"` : "the active account";
    const isThreadOp = toolName === "get_thread" || toolName === "modify_thread";
    let hint: string;
    if (!accountId) {
      hint = "no active account is configured — run `gmail account auth <id>` to set one up";
    } else if (isThreadOp) {
      hint =
        "verify the id is a threadId, not a messageId (use `read <id>` to fetch its `threadId` field). If the id is correct, it may belong to a different mailbox — `accounts` + `sw <id>` to switch.";
    } else {
      hint =
        "list accounts with `accounts` and switch with `sw <id>` if the id belongs to a different mailbox";
    }
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `${toolName} failed: no such message/thread in ${scope} — ${hint}`,
        },
      ],
    };
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${toolName} failed: ${message}`,
      },
    ],
  };
}

function formatReauthHint(): string {
  const accountId = getCurrentAccountId();
  return accountId
    ? `re-authenticate with \`gmail account auth ${accountId}\``
    : "re-authenticate with `gmail account auth <id>`";
}

/**
 * Test-only: reset the per-account refresh-attempt tracking.
 * @internal
 */
export function _resetForTests(): void {
  refreshAttemptedAt.clear();
}
