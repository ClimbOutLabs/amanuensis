// list_accounts + switch_account ops (Phase M2-light).
//
// Two meta-tools that operate on the local account manifest, never on Gmail:
//
//   list_accounts   — read.  Returns the manifest + which account is active.
//                     `readOnlyHint: true` so hosts allow it freely.
//   switch_account  — write. Loads credentials for a named account and swaps
//                     the session singletons. Hosts can permission-gate.
//
// Neither requires a Gmail scope; both run before any Gmail API call. The
// switch is best-effort relative to scopes — if the new account has narrower
// scopes than the previous one, the host's cached tools/list is stale and
// affected tools will reject at call-time with the usual re-auth hint.

import { info as logInfo, withRetry } from "@george43g/robustness";
import type { z } from "zod";
import { hasScope } from "../../scopes.js";
import {
  ListAccountsOutputSchema,
  ListAccountsSchema,
  SwitchAccountOutputSchema,
  SwitchAccountSchema,
  UnreadSummaryOutputSchema,
  UnreadSummarySchema,
} from "../../tools.js";
import { AccountGmailError, buildAccountGmail } from "../account-gmail.js";
import {
  AccountNotFoundError,
  listAccounts,
  loadManifest,
  resolveActiveAccount,
  validateAccountId,
} from "../accounts.js";
import { listMeta } from "../email-helpers.js";
import { type Operation, registry } from "../registry.js";
import { getCurrentAccountId, setSession } from "../session.js";
import { apiOpts } from "../api.js";
import { fanoutMap } from "../fanout.js";

type ListAccountsInput = z.infer<typeof ListAccountsSchema>;
type ListAccountsOutput = z.infer<typeof ListAccountsOutputSchema>;
type SwitchAccountInput = z.infer<typeof SwitchAccountSchema>;
type SwitchAccountOutput = z.infer<typeof SwitchAccountOutputSchema>;
type UnreadSummaryInput = z.infer<typeof UnreadSummarySchema>;
type UnreadSummaryOutput = z.infer<typeof UnreadSummaryOutputSchema>;
type UnreadSummaryAccount = UnreadSummaryOutput["accounts"][number];

const listOp: Operation<ListAccountsInput, ListAccountsOutput> = {
  name: "list_accounts",
  schema: ListAccountsSchema,
  outputSchema: ListAccountsOutputSchema,
  scopes: [],
  handler: async (_input, _ctx) => {
    const active = resolveActiveAccount();
    const items = listAccounts();
    const currentSessionAccount = getCurrentAccountId();

    // "Active" for display purposes: prefer the session's actually-loaded
    // account (i.e. what the next tool call will hit) over the manifest's
    // would-be active. Differs only briefly after a switch_account error or
    // before any bootstrap has happened.
    const activeIdForDisplay = currentSessionAccount ?? active.id;

    const accounts: ListAccountsOutput["accounts"] = items.map((item) => ({
      id: item.id,
      emailAddress: item.entry.emailAddress ?? null,
      scopes: item.entry.scopes ?? null,
      isDefault: item.isDefault,
      isActive: item.id === activeIdForDisplay,
      createdAt: item.entry.createdAt ?? null,
    }));

    const structured: ListAccountsOutput = {
      active: {
        id: activeIdForDisplay ?? null,
        source: active.source,
        isLegacyImplicit: active.isLegacyImplicit,
      },
      count: accounts.length,
      accounts,
      // The manifest is local and fully enumerated — never truncated.
      ...listMeta(accounts.length),
    };

    // Human-readable text for the legacy MCP envelope.
    const lines: string[] = [];
    if (accounts.length === 0) {
      lines.push("No accounts in the manifest yet.");
      lines.push("Run `gmail account auth <id>` from the shell to add one.");
    } else {
      lines.push(`${accounts.length} account(s) configured:`);
      for (const a of accounts) {
        const markers: string[] = [];
        if (a.isActive) markers.push("ACTIVE");
        if (a.isDefault) markers.push("default");
        const tag = markers.length > 0 ? `  [${markers.join(", ")}]` : "";
        const email = a.emailAddress ? ` <${a.emailAddress}>` : "";
        const scopes = a.scopes ? ` scopes=${a.scopes.join(",")}` : "";
        lines.push(`  - ${a.id}${email}${scopes}${tag}`);
      }
      lines.push("");
      lines.push(`Active: ${activeIdForDisplay ?? "(none)"} (source: ${active.source})`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: structured,
    };
  },
};

const switchOp: Operation<SwitchAccountInput, SwitchAccountOutput> = {
  name: "switch_account",
  schema: SwitchAccountSchema,
  outputSchema: SwitchAccountOutputSchema,
  scopes: [],
  handler: async (input, _ctx) => {
    const { accountId } = input;
    validateAccountId(accountId);

    const manifest = loadManifest();
    if (!manifest || !manifest.accounts[accountId]) {
      throw new AccountNotFoundError(accountId);
    }

    const previousAccountId = getCurrentAccountId();

    // No-op fast path: switching to the already-active account succeeds
    // without re-reading credentials. Idempotent.
    if (previousAccountId === accountId) {
      const entry = manifest.accounts[accountId];
      const structured: SwitchAccountOutput = {
        previousAccountId,
        newAccountId: accountId,
        emailAddress: entry?.emailAddress ?? null,
        scopes: entry?.scopes ?? [],
        note: "Account was already active. No session change.",
      };
      return {
        content: [{ type: "text", text: `Account "${accountId}" is already active. No change.` }],
        structuredContent: structured,
      };
    }

    const env = process.env;

    // Build a fresh handle for the target account WITHOUT going through the
    // session first — buildAccountGmail folds in fixture mode, OAuth-keys
    // loading, and the credential loader chain (the same code bootstrap and
    // the cross-account unread summary use). Map its typed stage error back
    // onto switch_account's historical messages.
    let bundle: Awaited<ReturnType<typeof buildAccountGmail>>;
    try {
      bundle = await buildAccountGmail(accountId, {
        env,
        onPersistError: (error) => {
          logInfo("failed to persist refreshed OAuth tokens", {
            account: accountId,
            error: error.message,
          });
        },
      });
    } catch (err) {
      if (err instanceof AccountGmailError) {
        if (err.stage === "oauth-keys") {
          throw new Error(
            `switch_account: failed to load OAuth keys for "${accountId}": ${err.message}`,
            { cause: err },
          );
        }
        if (err.stage === "credentials") {
          throw new Error(
            `switch_account: failed to load credentials for "${accountId}": ${err.message}. Run \`gmail account auth ${accountId}\` to mint them.`,
            { cause: err },
          );
        }
        throw new Error(
          `switch_account: failed to load fixture client for "${accountId}": ${err.message}`,
          { cause: err },
        );
      }
      throw err;
    }

    setSession({
      oauth2Client: bundle.oauth2Client,
      gmail: bundle.gmail,
      authorizedScopes: bundle.scopes,
      accountId,
    });
    logInfo(bundle.fixture ? "account swapped (fixture)" : "account swapped", {
      account: accountId,
      previousAccount: previousAccountId,
      scopes: bundle.scopes,
    });

    const entry = manifest.accounts[accountId];
    const note = bundle.fixture
      ? "Active account swapped (fixture mode)."
      : "Active account swapped. The host's cached tools/list does not auto-refresh; tools relying on scopes the new account lacks will reject at call-time.";
    const structured: SwitchAccountOutput = {
      previousAccountId: previousAccountId ?? null,
      newAccountId: accountId,
      emailAddress: entry?.emailAddress ?? null,
      scopes: bundle.scopes,
      note,
    };

    const lines = [
      `Switched active Gmail account: ${previousAccountId ?? "(none)"} → ${accountId}${
        bundle.fixture ? " (fixture)" : ""
      }`,
      `Scopes now granted: ${bundle.scopes.length > 0 ? bundle.scopes.join(", ") : "(none)"}`,
    ];
    if (entry?.emailAddress) lines.push(`Email: ${entry.emailAddress}`);

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: structured,
    };
  },
};

// ---------------------------------------------------------------------------
// unread_summary — read-only cross-account unread aggregate (Milestone C)
// ---------------------------------------------------------------------------
//
// The ONLY tool that reads more than one account. Strictly read-only: it builds
// an independent per-account Gmail handle via buildAccountGmail and NEVER calls
// setSession, so the active account is untouched. Accounts whose stored scopes
// lack a read scope are skipped (reported, not errored). One cheap labels.get
// per account (INBOX + UNREAD carry messagesUnread/threadsUnread) — no message
// fetch unless `includeSamples` is set.

/** Summarise a single account's unread counts. Never throws — folds every
 *  failure into an `error` / `skippedReason` field so allSettled stays clean. */
async function summariseAccount(
  item: ReturnType<typeof listAccounts>[number],
  env: NodeJS.ProcessEnv,
  includeSamples: boolean,
  signal?: AbortSignal,
): Promise<UnreadSummaryAccount> {
  const base = { id: item.id, emailAddress: item.entry.emailAddress ?? null };
  const scopes = item.entry.scopes ?? [];
  // labels.get needs gmail.readonly / gmail.modify (gmail.full also grants it).
  if (!hasScope(scopes, ["gmail.readonly", "gmail.modify"])) {
    return { ...base, unreadInbox: null, unreadTotal: null, skippedReason: "no read scope" };
  }

  let gmail: Awaited<ReturnType<typeof buildAccountGmail>>["gmail"];
  try {
    // persistTokens:false — a summary must not rewrite N credential files as a
    // side effect; the throwaway handle is discarded after the call.
    ({ gmail } = await buildAccountGmail(item.id, { env, persistTokens: false }));
  } catch (err) {
    const message =
      err instanceof AccountGmailError ? `${err.stage}: ${err.message}` : (err as Error).message;
    return { ...base, unreadInbox: null, unreadTotal: null, error: message };
  }

  try {
    const [inbox, unread] = await Promise.all([
      gmail.users.labels.get({ userId: "me", id: "INBOX" }, apiOpts({ signal })).then((r) => r.data),
      gmail.users.labels.get({ userId: "me", id: "UNREAD" }, apiOpts({ signal })).then((r) => r.data),
    ]);
    const result: UnreadSummaryAccount = {
      ...base,
      unreadInbox: typeof inbox.messagesUnread === "number" ? inbox.messagesUnread : null,
      unreadTotal: typeof unread.messagesUnread === "number" ? unread.messagesUnread : null,
    };
    if (includeSamples) {
      const list = await withRetry(
        () =>
          gmail.users.messages.list({
            userId: "me",
            q: "is:unread in:inbox",
            maxResults: 5,
          }, apiOpts({ signal })),
        { label: "gmail_messages_list" },
      );
      const ids = (list.data.messages ?? [])
        .map((m) => m.id)
        .filter((id): id is string => Boolean(id));
      result.samples = await fanoutMap(
        ids,
        async (id) => {
          const msg = await gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"],
          }, apiOpts({ signal }));
          const headers = msg.data.payload?.headers ?? [];
          const header = (name: string) =>
            headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
          return { id, from: header("From"), subject: header("Subject"), date: header("Date") };
        },
        { label: "gmail_unread_samples_fanout" },
      );
    }
    return result;
  } catch (err) {
    return { ...base, unreadInbox: null, unreadTotal: null, error: (err as Error).message };
  }
}

const unreadSummaryOp: Operation<UnreadSummaryInput, UnreadSummaryOutput> = {
  name: "unread_summary",
  schema: UnreadSummarySchema,
  outputSchema: UnreadSummaryOutputSchema,
  // Gated on the ACTIVE account having a read scope; per-account read
  // capability is checked in summariseAccount (out-of-scope accounts skip, not
  // reject). Read-only aggregate; never mutates session or Gmail.
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const env = process.env;
    const includeSamples = input.includeSamples ?? false;
    const items = listAccounts(env);
    const activeAccountId = getCurrentAccountId();

    const settled = await Promise.allSettled(
      items.map((item) => summariseAccount(item, env, includeSamples, ctx.signal)),
    );
    const accounts: UnreadSummaryAccount[] = settled.map((res, i) => {
      if (res.status === "fulfilled") return res.value;
      const item = items[i]!;
      return {
        id: item.id,
        emailAddress: item.entry.emailAddress ?? null,
        unreadInbox: null,
        unreadTotal: null,
        error: (res.reason as Error)?.message ?? String(res.reason),
      };
    });

    const totalUnread = accounts.reduce((sum, a) => sum + (a.unreadInbox ?? 0), 0);
    const structured: UnreadSummaryOutput = {
      activeAccountId: activeAccountId ?? null,
      totalUnread,
      accounts,
      // The manifest is local + fully enumerated — never truncated.
      ...listMeta(accounts.length),
    };

    const lines: string[] = [];
    if (accounts.length === 0) {
      lines.push("No accounts in the manifest yet.");
      lines.push("Run `gmail account auth <id>` from the shell to add one.");
    } else {
      lines.push(`Unread across ${accounts.length} account(s): ${totalUnread} in inbox(es)`);
      for (const a of accounts) {
        const marker = a.id === activeAccountId ? " *" : "";
        const email = a.emailAddress ? ` <${a.emailAddress}>` : "";
        if (a.skippedReason) {
          lines.push(`  - ${a.id}${email}${marker}: skipped (${a.skippedReason})`);
        } else if (a.error) {
          lines.push(`  - ${a.id}${email}${marker}: error — ${a.error}`);
        } else {
          lines.push(
            `  - ${a.id}${email}${marker}: ${a.unreadInbox ?? 0} inbox / ${a.unreadTotal ?? 0} total`,
          );
        }
        for (const s of a.samples ?? []) {
          lines.push(`      · ${s.from ?? "(unknown)"} — ${s.subject ?? "(no subject)"}`);
        }
      }
      lines.push("", "(* = active account)");
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: structured,
    };
  },
};

registry.register(listOp);
registry.register(switchOp);
registry.register(unreadSummaryOp);
