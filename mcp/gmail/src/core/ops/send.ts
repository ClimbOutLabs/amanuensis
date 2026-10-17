// send_email + reply_all ops, plus the shared `handleEmailAction` helper
// used by both send and draft paths. Lifted from src/index.ts verbatim.

import type { gmail_v1 } from "googleapis";
import type { z } from "zod";
import {
  addRePrefix,
  buildReplyAllRecipients,
  parseEmailAddresses,
  pickReplyFromIdentity,
} from "../../reply-all-helpers.js";
import { listSendAs } from "../../sendas-manager.js";
import {
  ReplyAllOutputSchema,
  ReplyAllSchema,
  SendEmailSchema,
  SendOrDraftOutputSchema,
} from "../../tools.js";
import { createEmailMessage, createEmailWithNodemailer, needsRawBuilder } from "../../utl.js";
import type { OperationContext } from "../context.js";
import { type Operation, type OperationResult, registry } from "../registry.js";
import { apiOpts } from "../api.js";
import { isNotFoundError } from "../../auth-errors.js";
import {
  forgetIdempotencyKey,
  generateRfc822MessageId,
  lookupIdempotencyKey,
  recordConfirmedSend,
  recordPendingSend,
  withIdempotencyKeyLock,
  type IdempotencyRecord,
} from "../idempotency.js";

export type SendOrDraftOutput = z.infer<typeof SendOrDraftOutputSchema>;
type ReplyAllOutput = z.infer<typeof ReplyAllOutputSchema>;

/**
 * Loose shape for validated send/draft args — the send and draft schemas
 * differ per entry op, so only the fields this worker reads are named.
 * Exported for the draft op, which delegates here.
 */
export interface SendArgs {
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  idempotencyKey?: string;
  /**
   * RFC822 Message-ID injected into the outgoing message. Set internally
   * from the idempotency gate so a crash between send and confirmation can
   * be reconciled by searching Gmail for this Message-ID.
   */
  rfc822MessageId?: string;
  [key: string]: unknown;
}

function idempotencyKeyOf(args: SendArgs): string | undefined {
  const key = args.idempotencyKey;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function replayResult(key: string, record: IdempotencyRecord): OperationResult<SendOrDraftOutput> {
  const messageId = record.messageId ?? "";
  const structured: SendOrDraftOutput = {
    messageId,
    action: "sent",
    idempotent_replay: true,
  };
  if (record.threadId !== undefined) structured.threadId = record.threadId;
  return {
    content: [
      {
        type: "text",
        text:
          `Email already sent (idempotent replay of key "${key}") with ID: ${messageId}. ` +
          `No new email was sent.`,
      },
    ],
    structuredContent: structured,
  };
}

/** Search Gmail for a message carrying our injected Message-ID. */
async function searchByRfc822MessageId(
  gmail: gmail_v1.Gmail,
  rfc822MessageId: string,
  ctx: OperationContext,
): Promise<{ id: string; threadId?: string } | undefined> {
  const bare = rfc822MessageId.replace(/^<|>$/g, "");
  const list = await gmail.users.messages.list(
    { userId: "me", q: `rfc822msgid:${bare}`, maxResults: 1 },
    apiOpts(ctx),
  );
  const hit = list.data.messages?.[0];
  if (!hit?.id) return undefined;
  return { id: hit.id, threadId: hit.threadId ?? undefined };
}

/**
 * How many times to search for an injected Message-ID before concluding a
 * pending send never landed. Gmail's search index lags a send by seconds; a
 * single search issued right after a crash-retry can miss the just-sent
 * message and cause a double-send. Bounded re-search (default 3 attempts /
 * 10s delays ≈ 20s of waiting plus API latency) closes the routine window —
 * the residual risk is index lag beyond the bound, which is pathological
 * rather than routine. Callers that need at-most-once semantics stronger
 * than "no duplicate within the bound" should not reuse keys blindly after
 * a crash; see the design note on recordPendingSend.
 *
 * Both knobs are env-overridable (GMAIL_IDEMPOTENCY_RECONCILE_ATTEMPTS,
 * GMAIL_IDEMPOTENCY_RECONCILE_DELAY_MS) so operators facing unusually slow
 * index propagation can widen the bound; invalid values fall back to the
 * defaults. Tests set the delay to 0 to exercise the loop without waiting.
 */
const RECONCILE_SEARCH_ATTEMPTS = 3;
const RECONCILE_SEARCH_DELAY_MS = 10_000;

function reconcileTuning(env: NodeJS.ProcessEnv = process.env): {
  attempts: number;
  delayMs: number;
} {
  const attempts = Number.parseInt(env.GMAIL_IDEMPOTENCY_RECONCILE_ATTEMPTS ?? "", 10);
  const delayMs = Number.parseInt(env.GMAIL_IDEMPOTENCY_RECONCILE_DELAY_MS ?? "", 10);
  return {
    attempts:
      Number.isSafeInteger(attempts) && attempts >= 1 ? attempts : RECONCILE_SEARCH_ATTEMPTS,
    delayMs:
      Number.isSafeInteger(delayMs) && delayMs >= 0 ? delayMs : RECONCILE_SEARCH_DELAY_MS,
  };
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("Aborted"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error("Aborted"),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type IdempotencyGate =
  | { kind: "replay"; result: OperationResult<SendOrDraftOutput> }
  | { kind: "proceed"; rfc822MessageId: string };

/**
 * Idempotency gate. When the caller supplied an idempotencyKey:
 * - a confirmed record is verified via messages.get (reconciliation) and
 *   replayed without re-sending; a 404 means the record is stale, so the
 *   record is forgotten and the send proceeds;
 * - a pending record means a previous attempt may have sent but crashed
 *   before confirming: reconcile by searching for the injected Message-ID.
 *   Found → promote to confirmed and replay. Not found → the send never
 *   landed; proceed reusing the same Message-ID so any later crash-retry
 *   still correlates.
 *
 * Fail-closed on verification errors other than 404: if we cannot confirm
 * the recorded message's state, erroring is safer than risking a duplicate —
 * the caller retries and the replay succeeds once the lookup works.
 */
async function checkIdempotencyGate(
  accountId: string,
  key: string,
  gmail: gmail_v1.Gmail,
  ctx: OperationContext,
): Promise<IdempotencyGate> {
  const record = await lookupIdempotencyKey(accountId, key);
  if (!record) return { kind: "proceed", rfc822MessageId: generateRfc822MessageId() };

  if (record.status === "sent" && record.messageId) {
    try {
      await gmail.users.messages.get(
        { userId: "me", id: record.messageId, format: "minimal" },
        apiOpts(ctx),
      );
    } catch (err) {
      if (isNotFoundError(err)) {
        await forgetIdempotencyKey(accountId, key);
        return { kind: "proceed", rfc822MessageId: generateRfc822MessageId() };
      }
      throw new Error(
        `Idempotency check failed for key "${key}": ${errorMessage(err)}. ` +
          `Not sending to avoid a possible duplicate — retry once Gmail is reachable.`,
        { cause: err },
      );
    }
    return { kind: "replay", result: replayResult(key, record) };
  }

  // Pending: reconcile via Message-ID search before deciding. Gmail's search
  // index lags a send by seconds, so a single immediate search can miss a
  // just-sent message and cause a double-send — search repeatedly (bounded)
  // before concluding the send never landed.
  const tuning = reconcileTuning();
  let found: { id: string; threadId?: string } | undefined;
  for (let attempt = 0; ; attempt++) {
    found = await searchByRfc822MessageId(gmail, record.rfc822MessageId, ctx).catch(
      (err: unknown) => {
        throw new Error(
          `Idempotency check failed for key "${key}": ${errorMessage(err)}. ` +
            `Not sending to avoid a possible duplicate — retry once Gmail is reachable.`,
          { cause: err },
        );
      },
    );
    if (found !== undefined || attempt + 1 >= tuning.attempts) break;
    try {
      await sleepAbortable(tuning.delayMs, ctx.signal);
    } catch (err: unknown) {
      throw new Error(
        `Idempotency check for key "${key}" was cancelled while waiting for Gmail's ` +
          `search index to settle. The send state is unknown — retry and the replay ` +
          `will succeed once the lookup completes.`,
        { cause: err },
      );
    }
  }
  if (found) {
    const confirmed: IdempotencyRecord = {
      status: "sent",
      rfc822MessageId: record.rfc822MessageId,
      messageId: found.id,
      createdAt: Date.now(),
    };
    if (found.threadId !== undefined) confirmed.threadId = found.threadId;
    await recordConfirmedSend(accountId, key, {
      messageId: found.id,
      threadId: found.threadId,
      rfc822MessageId: record.rfc822MessageId,
    });
    return { kind: "replay", result: replayResult(key, confirmed) };
  }
  // The bounded search did not find the message. The send state is genuinely
  // unknown: Gmail's index may still be catching up, or the send may never
  // have landed. Fail closed (at-most-once) rather than resending and
  // risking a duplicate. The operator retries intentionally with a NEW
  // idempotency key — or waits and retries with the same key, in which case
  // a later search will find the message and replay it.
  throw new Error(
    `Idempotency key "${key}" has a pending send that could not be confirmed: ` +
      `Gmail's search index did not return the message within the bounded ` +
      `reconciliation window. The send state is unknown — NOT resending to ` +
      `avoid a possible duplicate. Retry with a new idempotency key to send ` +
      `intentionally, or retry with the same key later to pick up the replay ` +
      `once Gmail's index settles.`,
  );
}

/**
 * Shared send/draft worker. Auto-resolves threading headers when a threadId
 * is provided but inReplyTo is missing. Handles both the nodemailer-RFC822
 * path (when attachments are present) and the simple base64-encoded path.
 *
 * Exported because draft_email (in core/ops/drafts.ts) and reply_all (below)
 * both delegate here. Private to the ops layer otherwise.
 */
/**
 * Shared send/draft worker. When the caller supplied an idempotencyKey, the
 * whole check → send → record sequence is serialized per (account, key) so
 * two concurrent sends with the same key cannot both pass the lookup and
 * double-send — within one process or across two sharing a config dir.
 * Drafts and key-less sends run unlocked.
 */
export function handleEmailAction(
  action: "send" | "draft",
  validatedArgs: SendArgs,
  ctx: OperationContext,
): Promise<OperationResult<SendOrDraftOutput>> {
  const idemKey = action === "send" ? idempotencyKeyOf(validatedArgs) : undefined;
  if (!idemKey) return runEmailAction(action, validatedArgs, ctx);
  // Scope the dedup key to the request's pinned account: the same client key
  // on two accounts must not share records, and the scope must match the
  // gmail client the request was issued against (ctx.accountId), not the
  // global session's account at send time — a concurrent switch_account
  // between gate and send would otherwise descope the record.
  const accountId = ctx.accountId ?? "default";
  return withIdempotencyKeyLock(accountId, idemKey, () =>
    runEmailAction(action, validatedArgs, ctx, { accountId, key: idemKey }),
  );
}

async function runEmailAction(
  action: "send" | "draft",
  validatedArgs: SendArgs,
  ctx: OperationContext,
  idem?: { accountId: string; key: string },
): Promise<OperationResult<SendOrDraftOutput>> {
  const gmail = ctx.gmail;
  let message: string;

  try {
    // Idempotency gate: a retry carrying the same client-supplied key must
    // never send twice. Checked before any other work so replays cost one
    // cheap messages.get instead of a full rebuild + send.
    let rfc822MessageId: string | undefined;
    if (idem && action === "send") {
      const gate = await checkIdempotencyGate(idem.accountId, idem.key, gmail, ctx);
      if (gate.kind === "replay") return gate.result;
      rfc822MessageId = gate.rfc822MessageId;
      validatedArgs.rfc822MessageId = rfc822MessageId;
      // Record the intent BEFORE messages.send: if we crash between the
      // send and the confirmation write, the next retry reconciles via
      // the Message-ID search in checkIdempotencyGate.
      await recordPendingSend(idem.accountId, idem.key, rfc822MessageId);
    }

    // Auto-resolve threading headers when threadId is provided but inReplyTo is missing
    if (validatedArgs.threadId && !validatedArgs.inReplyTo) {
      try {
        const threadResponse = await gmail.users.threads.get({
          userId: "me",
          id: validatedArgs.threadId,
          format: "metadata",
          metadataHeaders: ["Message-ID"],
        }, apiOpts(ctx));

        const threadMessages = threadResponse.data.messages || [];
        if (threadMessages.length > 0) {
          const allMessageIds: string[] = [];
          for (const msg of threadMessages) {
            const msgHeaders = msg.payload?.headers || [];
            const messageIdHeader = msgHeaders.find((h) => h.name?.toLowerCase() === "message-id");
            if (messageIdHeader?.value) {
              allMessageIds.push(messageIdHeader.value);
            }
          }

          const lastMessage = threadMessages[threadMessages.length - 1];
          const lastHeaders = lastMessage.payload?.headers || [];
          const lastMessageId = lastHeaders.find(
            (h) => h.name?.toLowerCase() === "message-id",
          )?.value;

          if (lastMessageId) {
            validatedArgs.inReplyTo = lastMessageId;
          }
          if (allMessageIds.length > 0) {
            validatedArgs.references = allMessageIds.join(" ");
          }
        }
      } catch (threadError: any) {
        console.warn(
          `Warning: Could not fetch thread ${validatedArgs.threadId} for header resolution: ${threadError.message}`,
        );
        // Continue without threading headers - degraded but not broken
      }
    }

    if (needsRawBuilder(validatedArgs)) {
      // Use nodemailer to construct a proper RFC822 multipart message.
      message = await createEmailWithNodemailer(validatedArgs);
      const encodedMessage = Buffer.from(message)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      if (action === "send") {
        const result = await gmail.users.messages.send({
          userId: "me",
          requestBody: {
            raw: encodedMessage,
            ...(validatedArgs.threadId && { threadId: validatedArgs.threadId }),
          },
        }, apiOpts(ctx));
        const sentId = result.data.id ?? "";
        if (idem && rfc822MessageId) {
          await recordConfirmedSend(idem.accountId, idem.key, {
            messageId: sentId,
            threadId: validatedArgs.threadId,
            rfc822MessageId,
          });
        }
        return {
          content: [{ type: "text", text: `Email sent successfully with ID: ${sentId}` }],
          structuredContent: {
            messageId: sentId,
            action: "sent",
            threadId: validatedArgs.threadId,
          },
        };
      }
      // draft branch
      const messageRequest = {
        raw: encodedMessage,
        ...(validatedArgs.threadId && { threadId: validatedArgs.threadId }),
      };
      const response = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: messageRequest },
      }, apiOpts(ctx));
      return {
        content: [
          { type: "text", text: `Email draft created successfully with ID: ${response.data.id}` },
        ],
        structuredContent: {
          messageId: response.data.id ?? "",
          draftId: response.data.id ?? "",
          action: "drafted",
          threadId: validatedArgs.threadId,
        },
      };
    }

    // No-attachment path: simpler raw RFC822 via utl.createEmailMessage.
    message = createEmailMessage(validatedArgs);
    const encodedMessage = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    interface GmailMessageRequest {
      raw: string;
      threadId?: string;
    }
    const messageRequest: GmailMessageRequest = { raw: encodedMessage };
    if (validatedArgs.threadId) messageRequest.threadId = validatedArgs.threadId;

    if (action === "send") {
      const response = await gmail.users.messages.send({
        userId: "me",
        requestBody: messageRequest,
      }, apiOpts(ctx));
      const sentId = response.data.id ?? "";
      if (idem && rfc822MessageId) {
        await recordConfirmedSend(idem.accountId, idem.key, {
          messageId: sentId,
          threadId: validatedArgs.threadId,
          rfc822MessageId,
        });
      }
      return {
        content: [{ type: "text", text: `Email sent successfully with ID: ${sentId}` }],
        structuredContent: {
          messageId: sentId,
          action: "sent",
          threadId: validatedArgs.threadId,
        },
      };
    }
    const response = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: messageRequest },
    }, apiOpts(ctx));
    return {
      content: [
        { type: "text", text: `Email draft created successfully with ID: ${response.data.id}` },
      ],
      structuredContent: {
        messageId: response.data.id ?? "",
        draftId: response.data.id ?? "",
        action: "drafted",
        threadId: validatedArgs.threadId,
      },
    };
  } catch (error: any) {
    if (needsRawBuilder(validatedArgs)) {
      console.error("Failed to build or send MIME email:", error.message);
    }
    throw error;
  }
}

const sendEmail: Operation<unknown, SendOrDraftOutput> = {
  name: "send_email",
  schema: SendEmailSchema,
  outputSchema: SendOrDraftOutputSchema,
  scopes: ["gmail.compose", "gmail.send"],
  handler: async (input, ctx: OperationContext) =>
    handleEmailAction("send", input as SendArgs, ctx),
};

const replyAll: Operation<unknown, ReplyAllOutput> = {
  name: "reply_all",
  schema: ReplyAllSchema,
  outputSchema: ReplyAllOutputSchema,
  scopes: ["gmail.compose", "gmail.send"],
  handler: async (input, ctx: OperationContext) => {
    const args = input as any;
    // Fetch the original email to get headers
    const originalEmail = await ctx.gmail.users.messages.get({
      userId: "me",
      id: args.messageId,
      format: "full",
    }, apiOpts(ctx));

    const headers = originalEmail.data.payload?.headers || [];
    const threadId = originalEmail.data.threadId || "";

    const originalFrom = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
    const originalTo = headers.find((h) => h.name?.toLowerCase() === "to")?.value || "";
    const originalCc = headers.find((h) => h.name?.toLowerCase() === "cc")?.value || "";
    const originalDeliveredTo =
      headers.find((h) => h.name?.toLowerCase() === "delivered-to")?.value || "";
    const originalSubject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
    const originalMessageId =
      headers.find((h) => h.name?.toLowerCase() === "message-id")?.value || "";
    // Get authenticated user's email to exclude from recipients
    const profile = await ctx.gmail.users.getProfile({ userId: "me" }, apiOpts(ctx));
    const myEmail = profile.data.emailAddress?.toLowerCase() || "";

    const { to: replyTo, cc: replyCc } = buildReplyAllRecipients(
      originalFrom,
      originalTo,
      originalCc,
      myEmail,
    );

    if (replyTo.length === 0) {
      throw new Error("Could not determine recipient for reply");
    }

    // Closest-matching reply-from selection. An explicit `from` in the args
    // always wins; otherwise pick the send-as identity nearest to whatever
    // address the original was delivered to (exact alias > same-domain alias),
    // which handles catch-all domains where no exact alias exists. Reading
    // send-as settings is best-effort — a failure degrades to the account
    // default ("me") rather than breaking the reply.
    let fromIdentity: string | undefined = args.from;
    if (!fromIdentity) {
      try {
        const aliases = await listSendAs(ctx.gmail, ctx.signal);
        const deliveredTo = [
          ...parseEmailAddresses(originalTo),
          ...parseEmailAddresses(originalCc),
          ...parseEmailAddresses(originalDeliveredTo),
        ];
        fromIdentity = pickReplyFromIdentity(deliveredTo, aliases);
      } catch {
        // Settings unreadable (scope/permission) — fall back to default send-as.
      }
    }

    const replySubject = addRePrefix(originalSubject);

    const emailArgs = {
      to: replyTo,
      cc: replyCc.length > 0 ? replyCc : undefined,
      subject: replySubject,
      body: args.body,
      htmlBody: args.htmlBody,
      mimeType: args.mimeType,
      threadId,
      inReplyTo: originalMessageId,
      attachments: args.attachments,
      inlineImages: args.inlineImages,
      ...(fromIdentity ? { from: fromIdentity } : {}),
      // Idempotency applies to reply sends too — pass the caller's key through.
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    };

    const sendResult = await handleEmailAction("send", emailArgs, ctx);
    // Idempotent replay: the inner send did not go out (same key seen
    // before). Surface that instead of claiming a fresh reply was sent.
    const replayed = sendResult.structuredContent?.idempotent_replay === true;

    const fromLine = fromIdentity ? `\nFrom: ${fromIdentity}` : "";
    const leadText = replayed
      ? `Reply already sent (idempotent replay${args.idempotencyKey ? ` of key "${args.idempotencyKey}"` : ""}). No new email was sent.`
      : `Reply-all sent successfully!`;
    return {
      content: [
        {
          type: "text",
          text: `${leadText}${fromLine}\nTo: ${replyTo.join(", ")}${replyCc.length > 0 ? `\nCC: ${replyCc.join(", ")}` : ""}\nSubject: ${replySubject}\nThread ID: ${threadId}`,
        },
      ],
      structuredContent: {
        to: replyTo,
        cc: replyCc,
        subject: replySubject,
        threadId,
        inReplyTo: originalMessageId,
        fromIdentity: fromIdentity ?? null,
        ...(replayed ? { idempotent_replay: true } : {}),
      },
    };
  },
};

registry.register(sendEmail);
registry.register(replyAll);
