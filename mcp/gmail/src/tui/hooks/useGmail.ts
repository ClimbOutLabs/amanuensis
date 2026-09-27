// Typed in-process Gmail dispatch hooks. Wraps `callOp` from cli/runtime so
// every TUI surface gets fully-typed payloads via the B2 outputSchemas. No
// React state lives here — callers manage their own state via the reducer.

import type { z } from "zod";
import { callOp } from "../../cli/runtime.js";
import { getCurrentAccountId, withoutSessionChangeEvents } from "../../core/session.js";
import type {
  GetThreadOutputSchema,
  ListAccountsOutputSchema,
  ListDraftsOutputSchema,
  ListEmailLabelsOutputSchema,
  ListInboxThreadsOutputSchema,
  ReadEmailOutputSchema,
  SearchEmailsOutputSchema,
  SwitchAccountOutputSchema,
} from "../../tools.js";
import type { BrowseScope } from "../reducer.js";

export type LabelList = z.infer<typeof ListEmailLabelsOutputSchema>;
export type ThreadList = z.infer<typeof ListInboxThreadsOutputSchema>;
export type ThreadView = z.infer<typeof GetThreadOutputSchema>;
export type EmailView = z.infer<typeof ReadEmailOutputSchema>;
export type SearchResults = z.infer<typeof SearchEmailsOutputSchema>;
export type AccountList = z.infer<typeof ListAccountsOutputSchema>;
export type SwitchAccountResult = z.infer<typeof SwitchAccountOutputSchema>;
export type DraftList = z.infer<typeof ListDraftsOutputSchema>;
export type ScopedThreadList = Omit<ThreadList, "threads"> & {
  threads: Array<
    ThreadList["threads"][number] & { accountId?: string; emailAddress?: string | null }
  >;
};
export type ScopedThreadView = Omit<ThreadView, "messages"> & {
  accountId?: string;
  emailAddress?: string | null;
  messages: Array<
    ThreadView["messages"][number] & { accountId?: string; emailAddress?: string | null }
  >;
};

export function listLabels(signal?: AbortSignal): Promise<LabelList> {
  return callOp<LabelList>("list_email_labels", {}, signal);
}

export function listInboxThreads(
  opts: { query?: string; maxResults?: number; pageToken?: string } = {},
  signal?: AbortSignal,
): Promise<ThreadList> {
  return callOp<ThreadList>(
    "list_inbox_threads",
    {
      query: opts.query,
      maxResults: opts.maxResults ?? 50,
      ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
    },
    signal,
  );
}

export async function listLabelsForScope(
  scope: BrowseScope,
  signal?: AbortSignal,
): Promise<LabelList> {
  if (scope.kind !== "single") return emptyLabels();
  if (scope.accountId && scope.accountId !== getCurrentAccountId()) {
    await switchAccount(scope.accountId, signal);
  }
  return listLabels(signal);
}

export async function listInboxThreadsForScope(
  scope: BrowseScope,
  opts: { query?: string; maxResults?: number; pageToken?: string } = {},
  signal?: AbortSignal,
): Promise<ScopedThreadList> {
  if (scope.kind === "single") {
    if (scope.accountId && scope.accountId !== getCurrentAccountId()) {
      await switchAccount(scope.accountId, signal);
    }
    return listInboxThreads(opts, signal);
  }

  return withRestoredAccount(async () => {
    const accounts = await listAccounts(signal);
    const ids =
      scope.kind === "all"
        ? accounts.accounts.map((a) => a.id)
        : scope.accountIds.filter((id) => accounts.accounts.some((a) => a.id === id));
    const emailById = new Map(accounts.accounts.map((a) => [a.id, a.emailAddress]));
    const threads: ScopedThreadList["threads"] = [];
    let anyTruncated = false;
    let totalAvailable = 0;
    for (const accountId of ids) {
      await switchAccount(accountId, signal);
      const list = await listInboxThreads(opts, signal);
      anyTruncated ||= list.truncated;
      totalAvailable += list.total_available;
      threads.push(
        ...list.threads.map((thread) => ({
          ...thread,
          accountId,
          emailAddress: emailById.get(accountId) ?? null,
        })),
      );
    }
    // Cross-account pagination is not supported — nextPageToken is
    // per-account and combining them would interleave inboxes in unstable
    // ways. The caller's UI just shows the per-account union of first
    // pages; for deep browsing the user picks a single account. The union is
    // truncated if any account was, and total_available sums the estimates.
    return {
      resultCount: threads.length,
      threads,
      truncated: anyTruncated,
      total_available: totalAvailable,
    };
  });
}

export function getThread(threadId: string, signal?: AbortSignal): Promise<ThreadView> {
  return callOp<ThreadView>("get_thread", { threadId, format: "full" }, signal);
}

export async function getThreadForScope(
  threadId: string,
  accountId?: string | null,
  signal?: AbortSignal,
): Promise<ScopedThreadView> {
  if (!accountId) return getThread(threadId, signal);
  if (accountId === getCurrentAccountId()) {
    const accounts = await listAccounts(signal).catch(() => null);
    const email = accounts?.accounts.find((a) => a.id === accountId)?.emailAddress ?? null;
    return annotateThread(await getThread(threadId, signal), accountId, email);
  }
  return withRestoredAccount(async () => {
    const accounts = await listAccounts(signal);
    const email = accounts.accounts.find((a) => a.id === accountId)?.emailAddress ?? null;
    await switchAccount(accountId, signal);
    const thread = await getThread(threadId, signal);
    return annotateThread(thread, accountId, email);
  });
}

export function readEmail(messageId: string, signal?: AbortSignal): Promise<EmailView> {
  return callOp<EmailView>("read_email", { messageId }, signal);
}

export function searchEmails(
  query: string,
  maxResults = 50,
  signal?: AbortSignal,
): Promise<SearchResults> {
  return callOp<SearchResults>("search_emails", { query, maxResults }, signal);
}

export function listAccounts(signal?: AbortSignal): Promise<AccountList> {
  return callOp<AccountList>("list_accounts", {}, signal);
}

export function switchAccount(
  accountId: string,
  signal?: AbortSignal,
): Promise<SwitchAccountResult> {
  return callOp<SwitchAccountResult>("switch_account", { accountId }, signal);
}

function emptyLabels(): LabelList {
  return {
    count: { total: 0, system: 0, user: 0 },
    system: [],
    user: [],
    truncated: false,
    total_available: 0,
  };
}

async function withRestoredAccount<T>(fn: () => Promise<T>): Promise<T> {
  const previous = getCurrentAccountId();
  return withoutSessionChangeEvents(async () => {
    try {
      return await fn();
    } finally {
      const current = getCurrentAccountId();
      if (previous && current !== previous) {
        await switchAccount(previous).catch(() => undefined);
      }
    }
  });
}

function annotateThread(
  thread: ThreadView,
  accountId: string,
  emailAddress: string | null,
): ScopedThreadView {
  return {
    ...thread,
    accountId,
    emailAddress,
    messages: thread.messages.map((message) => ({ ...message, accountId, emailAddress })),
  };
}

export interface SendEmailArgs {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  threadId?: string;
  inReplyTo?: string;
}

export function sendEmail(args: SendEmailArgs, signal?: AbortSignal): Promise<unknown> {
  return callOp("send_email", args, signal);
}

export function draftEmail(args: SendEmailArgs, signal?: AbortSignal): Promise<unknown> {
  return callOp("draft_email", args, signal);
}

export function listDrafts(
  opts: { maxResults?: number; pageToken?: string } = {},
  signal?: AbortSignal,
): Promise<DraftList> {
  return callOp<DraftList>(
    "list_drafts",
    {
      ...(opts.maxResults ? { maxResults: opts.maxResults } : {}),
      ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
    },
    signal,
  );
}

/** Replace an existing draft's content in place (preserves the draft id). */
export function updateDraft(
  args: SendEmailArgs & { draftId: string },
  signal?: AbortSignal,
): Promise<unknown> {
  return callOp("update_draft", args, signal);
}

/** Send an existing draft atomically and remove it from Drafts. */
export function sendDraft(draftId: string, signal?: AbortSignal): Promise<unknown> {
  return callOp("send_draft", { draftId }, signal);
}

export function deleteDraft(draftId: string, signal?: AbortSignal): Promise<unknown> {
  return callOp("delete_draft", { draftId }, signal);
}

export function replyAll(
  args: { messageId: string; body: string },
  signal?: AbortSignal,
): Promise<unknown> {
  return callOp("reply_all", args, signal);
}

export function modifyEmail(
  args: { messageId: string; addLabelIds?: string[]; removeLabelIds?: string[] },
  signal?: AbortSignal,
): Promise<unknown> {
  return callOp("modify_email", args, signal);
}

export function deleteEmail(messageId: string, signal?: AbortSignal): Promise<unknown> {
  return callOp("delete_email", { messageId }, signal);
}

export function modifyThread(
  args: { threadId: string; addLabelIds?: string[]; removeLabelIds?: string[] },
  signal?: AbortSignal,
): Promise<unknown> {
  return callOp("modify_thread", args, signal);
}

export function getOrCreateLabel(
  name: string,
  signal?: AbortSignal,
): Promise<{ id: string; name: string; created?: boolean }> {
  return callOp("get_or_create_label", { name }, signal);
}

export function downloadAttachment(
  args: { messageId: string; attachmentId: string; savePath?: string; filename?: string },
  signal?: AbortSignal,
): Promise<{
  status: "saved";
  path: string;
  filename: string;
  size: number;
  messageId: string;
  attachmentId: string;
}> {
  return callOp("download_attachment", args, signal);
}
