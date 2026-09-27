import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Schema definitions
export const InlineImageSchema = z
  .object({
    cid: z
      .string()
      .min(1)
      .regex(
        /^[^\s<>\r\n\0]+$/,
        "cid must not contain whitespace, angle brackets, or control characters",
      )
      .describe('Content-ID referenced from htmlBody as <img src="cid:CID">'),
    path: z
      .string()
      .optional()
      .describe(
        "Image file path (use this or content). Confined to the attachments sandbox " +
          "(<configDir>/attachments, or GMAIL_ATTACHMENTS_DIR): relative paths resolve inside it, " +
          "absolute paths must land inside it; symlinks escaping it are rejected.",
      ),
    content: z.string().optional().describe("Base64-encoded image data (use this or path)"),
    contentType: z
      .enum(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon"])
      .optional()
      .describe("Raster image MIME type; required when content is provided"),
    filename: z.string().optional().describe("Display filename for the inline image"),
  })
  .superRefine((image, ctx) => {
    if (Number(Boolean(image.path)) + Number(Boolean(image.content)) !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each inline image must set exactly one of path or content",
      });
    }
    if (image.content && !image.contentType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "contentType is required when an inline image uses content",
      });
    }
  });

const EmailMessageSchema = z.object({
  to: z.array(z.string()).describe("List of recipient email addresses"),
  subject: z.string().describe("Email subject"),
  body: z
    .string()
    .describe("Email body content (used for text/plain or when htmlBody not provided)"),
  from: z
    .string()
    .optional()
    .describe(
      "Sender email address (must be a configured send-as alias in Gmail settings). Defaults to account's default send-as address if not specified.",
    ),
  htmlBody: z.string().optional().describe("HTML version of the email body"),
  mimeType: z
    .enum(["text/plain", "text/html", "multipart/alternative"])
    .optional()
    .default("text/plain")
    .describe("Email content type"),
  cc: z.array(z.string()).optional().describe("List of CC recipients"),
  bcc: z.array(z.string()).optional().describe("List of BCC recipients"),
  threadId: z.string().optional().describe("Thread ID to reply to"),
  inReplyTo: z.string().optional().describe("Message ID being replied to"),
  attachments: z
    .array(z.string())
    .optional()
    .describe(
      "List of file paths to attach to the email. Confined to the attachments sandbox " +
        "(<configDir>/attachments, or GMAIL_ATTACHMENTS_DIR): relative paths resolve inside it, " +
        "absolute paths must land inside it; symlinks escaping it are rejected.",
    ),
  inlineImages: z
    .array(InlineImageSchema)
    .optional()
    .describe('Images embedded in htmlBody and referenced via <img src="cid:CID">'),
});

function requireHtmlForInlineImages(
  input: { htmlBody?: string; inlineImages?: unknown[] },
  ctx: z.RefinementCtx,
): void {
  if (input.inlineImages?.length && !input.htmlBody) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["htmlBody"],
      message: "htmlBody is required when inlineImages are provided",
    });
  }
}

export const SendEmailSchema = EmailMessageSchema.extend({
  idempotencyKey: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Client-supplied idempotency key. When present, the server records the sent message ID " +
        "under this key for 24h; retrying with the same key returns the original result instead " +
        "of sending a duplicate. Generate with crypto.randomUUID() and reuse it across retries " +
        "of the same logical send. Ignored by draft creation.",
    ),
}).superRefine(requireHtmlForInlineImages);

export const SendDraftSchema = z.object({
  draftId: z.string().min(1).describe("ID of the draft to send"),
});

export const DeleteDraftSchema = z.object({
  draftId: z.string().min(1).describe("ID of the draft to delete"),
});

export const UpdateDraftSchema = EmailMessageSchema.extend({
  draftId: z.string().min(1).describe("ID of the draft to update"),
}).superRefine(requireHtmlForInlineImages);

export const ListDraftsSchema = z.object({
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Maximum drafts to return in this page (hard ceiling: 500 per Gmail API). Paginate via pageToken for more.",
    ),
  pageToken: z
    .string()
    .optional()
    .describe("Continuation token from a prior response's nextPageToken."),
});

export const ReadEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to retrieve"),
});

export const SearchEmailsSchema = z.object({
  query: z.string().describe("Gmail search query (e.g., 'from:friend@example.com')"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Maximum messages to return in this page (hard ceiling: 500 per Gmail API). Paginate via pageToken for more.",
    ),
  pageToken: z
    .string()
    .optional()
    .describe("Continuation token from a prior response's nextPageToken."),
});

export const ModifyEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to modify"),
  labelIds: z.array(z.string()).optional().describe("List of label IDs to apply"),
  addLabelIds: z.array(z.string()).optional().describe("List of label IDs to add to the message"),
  removeLabelIds: z
    .array(z.string())
    .optional()
    .describe("List of label IDs to remove from the message"),
});

export const DeleteEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to delete"),
});

export const ListEmailLabelsSchema = z.object({}).describe("Retrieves all available Gmail labels");

export const CreateLabelSchema = z
  .object({
    name: z.string().describe("Name for the new label"),
    messageListVisibility: z
      .enum(["show", "hide"])
      .optional()
      .describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z
      .enum(["labelShow", "labelShowIfUnread", "labelHide"])
      .optional()
      .describe("Visibility of the label in the label list"),
  })
  .describe("Creates a new Gmail label");

export const UpdateLabelSchema = z
  .object({
    id: z.string().describe("ID of the label to update"),
    name: z.string().optional().describe("New name for the label"),
    messageListVisibility: z
      .enum(["show", "hide"])
      .optional()
      .describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z
      .enum(["labelShow", "labelShowIfUnread", "labelHide"])
      .optional()
      .describe("Visibility of the label in the label list"),
  })
  .describe("Updates an existing Gmail label");

export const DeleteLabelSchema = z
  .object({
    id: z.string().describe("ID of the label to delete"),
  })
  .describe("Deletes a Gmail label");

export const GetOrCreateLabelSchema = z
  .object({
    name: z.string().describe("Name of the label to get or create"),
    messageListVisibility: z
      .enum(["show", "hide"])
      .optional()
      .describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z
      .enum(["labelShow", "labelShowIfUnread", "labelHide"])
      .optional()
      .describe("Visibility of the label in the label list"),
  })
  .describe("Gets an existing label by name or creates it if it doesn't exist");

// Hard cap on batch size to prevent OOM / runaway loops on hostile or
// over-eager input. Gmail's batchModify/batchDelete API accepts up to 1000
// per call but we run our own batch loop on top of that, so 500 is plenty.
export const BATCH_MESSAGE_IDS_MAX = 500;

export const BatchModifyEmailsSchema = z.object({
  messageIds: z
    .array(z.string())
    .max(BATCH_MESSAGE_IDS_MAX, `messageIds must contain ${BATCH_MESSAGE_IDS_MAX} or fewer entries`)
    .describe(`List of message IDs to modify (max ${BATCH_MESSAGE_IDS_MAX})`),
  addLabelIds: z.array(z.string()).optional().describe("List of label IDs to add to all messages"),
  removeLabelIds: z
    .array(z.string())
    .optional()
    .describe("List of label IDs to remove from all messages"),
  batchSize: z
    .number()
    .int()
    .min(1)
    .max(BATCH_MESSAGE_IDS_MAX)
    .optional()
    .default(50)
    .describe(
      `Number of messages to process in each batch (default: 50, max ${BATCH_MESSAGE_IDS_MAX})`,
    ),
});

export const BatchDeleteEmailsSchema = z.object({
  messageIds: z
    .array(z.string())
    .max(BATCH_MESSAGE_IDS_MAX, `messageIds must contain ${BATCH_MESSAGE_IDS_MAX} or fewer entries`)
    .describe(`List of message IDs to delete (max ${BATCH_MESSAGE_IDS_MAX})`),
  batchSize: z
    .number()
    .int()
    .min(1)
    .max(BATCH_MESSAGE_IDS_MAX)
    .optional()
    .default(50)
    .describe(
      `Number of messages to process in each batch (default: 50, max ${BATCH_MESSAGE_IDS_MAX})`,
    ),
});

export const ReportPhishingSchema = z
  .object({
    messageId: z.string().min(1).describe("ID of the email message to mark as spam"),
  })
  .describe(
    "Applies Gmail's SPAM label as the closest public API approximation of reporting phishing",
  );

export const BatchReportPhishingSchema = z
  .object({
    messageIds: z
      .array(z.string())
      .max(
        BATCH_MESSAGE_IDS_MAX,
        `messageIds must contain ${BATCH_MESSAGE_IDS_MAX} or fewer entries`,
      )
      .describe(`List of message IDs to mark as spam (max ${BATCH_MESSAGE_IDS_MAX})`),
    batchSize: z.number().int().min(1).max(BATCH_MESSAGE_IDS_MAX).optional().default(50),
  })
  .describe(
    "Applies Gmail's SPAM label to multiple messages as the closest public API approximation of reporting phishing",
  );

export const CreateFilterSchema = z
  .object({
    criteria: z
      .object({
        from: z.string().optional().describe("Sender email address to match"),
        to: z.string().optional().describe("Recipient email address to match"),
        subject: z.string().optional().describe("Subject text to match"),
        query: z.string().optional().describe("Gmail search query (e.g., 'has:attachment')"),
        negatedQuery: z.string().optional().describe("Text that must NOT be present"),
        hasAttachment: z.boolean().optional().describe("Whether to match emails with attachments"),
        excludeChats: z.boolean().optional().describe("Whether to exclude chat messages"),
        size: z.number().optional().describe("Email size in bytes"),
        sizeComparison: z
          .enum(["unspecified", "smaller", "larger"])
          .optional()
          .describe("Size comparison operator"),
      })
      .describe("Criteria for matching emails"),
    action: z
      .object({
        addLabelIds: z.array(z.string()).optional().describe("Label IDs to add to matching emails"),
        removeLabelIds: z
          .array(z.string())
          .optional()
          .describe("Label IDs to remove from matching emails"),
        forward: z.string().optional().describe("Email address to forward matching emails to"),
      })
      .describe("Actions to perform on matching emails"),
  })
  .describe("Creates a new Gmail filter");

export const ListFiltersSchema = z.object({}).describe("Retrieves all Gmail filters");

export const GetFilterSchema = z
  .object({
    filterId: z.string().describe("ID of the filter to retrieve"),
  })
  .describe("Gets details of a specific Gmail filter");

export const DeleteFilterSchema = z
  .object({
    filterId: z.string().describe("ID of the filter to delete"),
  })
  .describe("Deletes a Gmail filter");

export const CreateFilterFromTemplateSchema = z
  .object({
    template: z
      .enum([
        "fromSender",
        "withSubject",
        "withAttachments",
        "largeEmails",
        "containingText",
        "mailingList",
      ])
      .describe("Pre-defined filter template to use"),
    parameters: z
      .object({
        senderEmail: z.string().optional().describe("Sender email (for fromSender template)"),
        subjectText: z.string().optional().describe("Subject text (for withSubject template)"),
        searchText: z
          .string()
          .optional()
          .describe("Text to search for (for containingText template)"),
        listIdentifier: z
          .string()
          .optional()
          .describe("Mailing list identifier (for mailingList template)"),
        sizeInBytes: z
          .number()
          .optional()
          .describe("Size threshold in bytes (for largeEmails template)"),
        labelIds: z.array(z.string()).optional().describe("Label IDs to apply"),
        archive: z.boolean().optional().describe("Whether to archive (skip inbox)"),
        markAsRead: z.boolean().optional().describe("Whether to mark as read"),
        markImportant: z.boolean().optional().describe("Whether to mark as important"),
      })
      .describe("Template-specific parameters"),
  })
  .describe("Creates a filter using a pre-defined template");

export const DownloadAttachmentSchema = z.object({
  messageId: z.string().describe("ID of the email message containing the attachment"),
  attachmentId: z.string().describe("ID of the attachment to download"),
  filename: z
    .string()
    .optional()
    .describe("Filename to save the attachment as (if not provided, uses original filename)"),
  savePath: z
    .string()
    .optional()
    .describe(
      "Directory to save the attachment. Confined to the downloads sandbox " +
        "(<configDir>/downloads, or GMAIL_DOWNLOADS_DIR): relative paths resolve inside it, " +
        "absolute paths must land inside it; symlinks escaping it are rejected. " +
        "Defaults to the sandbox root.",
    ),
});

export const DownloadEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to download"),
  savePath: z
    .string()
    .optional()
    .describe(
      "Directory to save the email file. Confined to the downloads sandbox " +
        "(<configDir>/downloads, or GMAIL_DOWNLOADS_DIR): relative paths resolve inside it, " +
        "absolute paths must land inside it; symlinks escaping it are rejected. " +
        "Defaults to the sandbox root.",
    ),
  format: z
    .enum(["json", "eml", "txt", "html"])
    .optional()
    .default("json")
    .describe(
      "Output format: json (structured data), eml (raw RFC822), txt (plain text), html (formatted HTML)",
    ),
});

export const ModifyThreadSchema = z.object({
  threadId: z.string().describe("ID of the Gmail thread to modify"),
  addLabelIds: z
    .array(z.string())
    .optional()
    .describe("List of label IDs to add to all messages in the thread"),
  removeLabelIds: z
    .array(z.string())
    .optional()
    .describe("List of label IDs to remove from all messages in the thread"),
});

// Thread-level schemas
export const GetThreadSchema = z
  .object({
    threadId: z
      .string()
      .optional()
      .describe("ID of the email thread to retrieve. Provide either this or messageId."),
    messageId: z
      .string()
      .optional()
      .describe(
        "ID of a message in the thread. Resolves to its threadId first — pass this when a search returned a message id but not a thread id, to avoid a separate read_email round-trip.",
      ),
    format: z
      .enum(["full", "metadata", "minimal"])
      .optional()
      .default("full")
      .describe("Format of the email messages returned (default: full)"),
  })
  .refine((v) => Boolean(v.threadId) !== Boolean(v.messageId), {
    message: "Provide exactly one of threadId or messageId",
  });

export const ListInboxThreadsSchema = z.object({
  query: z
    .string()
    .optional()
    .default("in:inbox")
    .describe("Gmail search query (default: 'in:inbox')"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(50)
    .describe(
      "Maximum threads to return in this page (default: 50, hard ceiling: 500 per Gmail API). MCP callers: do NOT pass values close to 500 unless you genuinely need them — each thread fans out to a metadata.get RPC. Paginate via pageToken instead.",
    ),
  pageToken: z
    .string()
    .optional()
    .describe("Continuation token from a prior response's nextPageToken. Omit for the first page."),
});

export const GetInboxWithThreadsSchema = z.object({
  query: z
    .string()
    .optional()
    .default("in:inbox")
    .describe("Gmail search query (default: 'in:inbox')"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(50)
    .describe(
      "Maximum number of threads to return (1-500, default: 50). " +
        "Note: thread expansion is capped at 25 threads regardless; refine the query or paginate for more.",
    ),
  expandThreads: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to fetch full thread content for each thread (default: true)"),
});

// Reply All schema - fetches original email and builds recipient list automatically
export const ReplyAllSchema = z
  .object({
    messageId: z.string().describe("ID of the email message to reply to"),
    body: z
      .string()
      .describe("Reply body content (used for text/plain or when htmlBody not provided)"),
    htmlBody: z.string().optional().describe("HTML version of the reply body"),
    mimeType: z
      .enum(["text/plain", "text/html", "multipart/alternative"])
      .optional()
      .default("text/plain")
      .describe("Email content type"),
    from: z
      .string()
      .optional()
      .describe(
        "Override the send-as identity to reply from (must be a configured alias). When omitted, the closest-matching send-as identity to the original recipient is chosen automatically (exact alias > same-domain alias > account default).",
      ),
    attachments: z
      .array(z.string())
      .optional()
      .describe(
        "List of file paths to attach to the reply. Confined to the attachments sandbox " +
          "(<configDir>/attachments, or GMAIL_ATTACHMENTS_DIR): relative paths resolve inside it, " +
          "absolute paths must land inside it; symlinks escaping it are rejected.",
      ),
    inlineImages: z
      .array(InlineImageSchema)
      .optional()
      .describe('Images embedded in htmlBody and referenced via <img src="cid:CID">'),
    idempotencyKey: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "Client-supplied idempotency key. When present, the server records the sent message ID " +
          "under this key for 24h; retrying with the same key returns the original result instead " +
          "of sending a duplicate. Generate with crypto.randomUUID() and reuse it across retries " +
          "of the same logical send.",
      ),
  })
  .superRefine(requireHtmlForInlineImages);

// Robustness — does NOT touch the Gmail API.
export const HealthCheckSchema = z
  .object({})
  .describe(
    "Returns server health metrics (uptime, memory, event-loop p99, tool call count, recent errors). Does not call Gmail.",
  );

// Multi-account management — does NOT touch the Gmail API.
export const ListAccountsSchema = z
  .object({})
  .describe(
    "Lists configured Gmail accounts from the local manifest and identifies the currently active account. Read-only; does not call Gmail.",
  );

export const SwitchAccountSchema = z
  .object({
    accountId: z
      .string()
      .min(1)
      .describe(
        "Account id to make active. Must already exist on disk — see `list_accounts` for available ids, or run `gmail account auth <id>` from the shell first.",
      ),
  })
  .describe(
    "Switches the active Gmail account for subsequent tool calls. State change, not destructive.",
  );

export const UnreadSummarySchema = z
  .object({
    includeSamples: z
      .boolean()
      .optional()
      .describe(
        "When true, include up to 5 sample unread inbox messages (from/subject/date) per account. Costs one messages.list + metadata fetch per account; off by default.",
      ),
  })
  .describe(
    "Read-only cross-account summary of unread mail. Aggregates unread counts across every configured account WITHOUT changing the active account. Does not fetch message bodies unless includeSamples is set.",
  );

// ----------------------------------------------------------------------------
// Output schemas (Phase B2)
//
// Optional typed shapes for each op's structured output. The MCP wire protocol
// keeps the legacy `content: [{type:"text", text:"..."}]` envelope; the typed
// payload is mirrored into `structuredContent` so:
//   - `gmail-cli ... --json` emits the structured JSON instead of wrapped text
//   - the future TUI binds to typed `result.structuredContent` directly
//   - MCP hosts that respect outputSchema get type info
// Handlers that don't define one fall back to text-only — same behavior as today.
// ----------------------------------------------------------------------------

// Common attachment metadata shape used by message / thread / download outputs.
const AttachmentMetaSchema = z.object({
  id: z.string().optional(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
});

/** A parsed RFC-5322 address: display name + lowercased email. Emails are
    lowercased so agents can correlate the same address across tools without
    case-sensitive string matching (groundwork for a shared identity schema). */
export const ParsedAddressSchema = z.object({
  name: z.string(),
  email: z.string(),
});

const SearchEmailResultSchema = z.object({
  id: z.string().nullable(),
  /** Gmail thread id for this message — lets callers open the thread via
      get_thread without a separate read_email round-trip. */
  threadId: z.string().nullable(),
  subject: z.string(),
  /** Raw `From:` header string (e.g. `"Name <a@b.com>"`) — kept for
      back-compat with existing `gmail search --json` consumers. */
  from: z.string(),
  /** Structured sender: display name + lowercased email. */
  fromAddress: ParsedAddressSchema,
  /** Structured `To:` recipients (display name + lowercased email). */
  to: z.array(ParsedAddressSchema),
  /** Structured `Cc:` recipients (display name + lowercased email). */
  cc: z.array(ParsedAddressSchema),
  date: z.string(),
});

export const SearchEmailsOutputSchema = z.object({
  resultCount: z.number(),
  results: z.array(SearchEmailResultSchema),
  /** Continuation token; pass back as pageToken for the next page. */
  nextPageToken: z.string().optional(),
  /** Gmail's server-side estimate of the total result-set size. */
  resultSizeEstimate: z.number().optional(),
  /** True if more results exist server-side than were returned here. */
  truncated: z.boolean(),
  /** Best-effort total matching count (Gmail's estimate for paginated queries). */
  total_available: z.number(),
});

export const ReadEmailOutputSchema = z.object({
  messageId: z.string(),
  threadId: z.string(),
  subject: z.string(),
  from: z.string(),
  to: z.string(),
  cc: z.string(),
  bcc: z.string(),
  date: z.string(),
  rfcMessageId: z.string(),
  body: z.string(),
  bodyText: z.string(),
  bodyHtml: z.string(),
  attachments: z.array(AttachmentMetaSchema),
});

const ThreadMessageSummarySchema = z.object({
  messageId: z.string(),
  threadId: z.string(),
  from: z.string(),
  to: z.string(),
  cc: z.string(),
  bcc: z.string(),
  subject: z.string(),
  date: z.string(),
  body: z.string(),
  labelIds: z.array(z.string()),
  // `id` is the Gmail attachmentId — present whenever the message has a
  // body.attachmentId on the part. Without this, callers had to issue a
  // separate `read_email` per message to download attachments from a
  // thread view (TUI and CLI both surface attachments per-message).
  attachments: z.array(
    z.object({
      id: z.string().optional(),
      filename: z.string(),
      mimeType: z.string(),
      size: z.number(),
    }),
  ),
});

export const GetThreadOutputSchema = z.object({
  threadId: z.string(),
  messageCount: z.number(),
  messages: z.array(ThreadMessageSummarySchema),
  /** A thread is fully enumerated, so this is always false. */
  truncated: z.boolean(),
  /** Total messages in the thread (equals messageCount). */
  total_available: z.number(),
});

const ThreadSummarySchema = z.object({
  threadId: z.string(),
  snippet: z.string(),
  historyId: z.string(),
  messageCount: z.number(),
  latestMessage: z.object({
    from: z.string(),
    subject: z.string(),
    date: z.string(),
  }),
});

export const ListInboxThreadsOutputSchema = z.object({
  resultCount: z.number(),
  threads: z.array(ThreadSummarySchema),
  /** Gmail's nextPageToken — pass this back as pageToken to fetch the next
      page. Absent or empty string means the result set is exhausted. */
  nextPageToken: z.string().optional(),
  /** Gmail's resultSizeEstimate — best-effort total count for the query
      across all pages (server-side estimate, not exact). Used by the TUI
      header to show "X of ~Y" before all pages have been fetched. */
  resultSizeEstimate: z.number().optional(),
  /** True if more threads exist server-side than were returned here. */
  truncated: z.boolean(),
  /** Best-effort total matching thread count (Gmail's estimate). */
  total_available: z.number(),
});

export const GetInboxWithThreadsOutputSchema = z.object({
  resultCount: z.number(),
  threads: z.array(
    z.union([
      ThreadSummarySchema,
      z.object({
        threadId: z.string(),
        messageCount: z.number(),
        messages: z.array(ThreadMessageSummarySchema),
      }),
    ]),
  ),
  /** True if more threads matched than were returned here. */
  truncated: z.boolean(),
  /** Best-effort total matching thread count. */
  total_available: z.number(),
});

const LabelEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
});

export const ListEmailLabelsOutputSchema = z.object({
  count: z.object({ total: z.number(), system: z.number(), user: z.number() }),
  system: z.array(LabelEntrySchema),
  user: z.array(LabelEntrySchema),
  /** Labels are fully enumerated, so this is always false. */
  truncated: z.boolean(),
  /** Total labels returned (equals count.total). */
  total_available: z.number(),
});

export const LabelMutationOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});

export const LabelDeleteOutputSchema = z.object({
  id: z.string(),
  status: z.literal("deleted"),
  message: z.string(),
});

export const FilterEntrySchema = z.object({
  id: z.string(),
  criteria: z.record(z.string(), z.unknown()).optional(),
  action: z.record(z.string(), z.unknown()).optional(),
});

export const ListFiltersOutputSchema = z.object({
  count: z.number(),
  filters: z.array(FilterEntrySchema),
  /** Filters are fully enumerated, so this is always false. */
  truncated: z.boolean(),
  /** Total filters returned (equals count). */
  total_available: z.number(),
});

export const GetFilterOutputSchema = FilterEntrySchema;

// Send-as identities + inbound routing (catch-all awareness). Read-only.
export const ListSendIdentitiesSchema = z
  .object({})
  .describe("Lists configured send-as identities, forwarding addresses, and routing filters.");

const SendIdentitySchema = z.object({
  email: z.string(),
  displayName: z.string().nullable(),
  isDefault: z.boolean(),
  isPrimary: z.boolean(),
  treatAsAlias: z.boolean(),
  verificationStatus: z.string().nullable(),
});

const InboundRoutingFilterSchema = z.object({
  id: z.string(),
  /** `to:` criterion — the recipient address/pattern this filter matches on. */
  to: z.string().nullable(),
  from: z.string().nullable(),
  query: z.string().nullable(),
  addLabelIds: z.array(z.string()),
  removeLabelIds: z.array(z.string()),
  forward: z.string().nullable(),
});

export const ListSendIdentitiesOutputSchema = z.object({
  /** Identities the account can send as (primary + verified aliases). */
  sendAsIdentities: z.array(SendIdentitySchema),
  /** Gmail-side forwarding addresses configured on the account. */
  forwardingAddresses: z.array(
    z.object({ email: z.string(), verificationStatus: z.string().nullable() }),
  ),
  /** Filters that route inbound mail (label/forward actions, or a `to:`
      criterion) — lets an agent infer "mail to X@domain lands in label Y",
      the signal for a catch-all/forwarding setup. */
  inboundRoutingFilters: z.array(InboundRoutingFilterSchema),
  truncated: z.boolean(),
  total_available: z.number(),
});

export const CreateFilterOutputSchema = z.object({
  id: z.string(),
  criteria: z.record(z.string(), z.unknown()),
  action: z.record(z.string(), z.unknown()),
});

export const DeleteFilterOutputSchema = z.object({
  id: z.string(),
  status: z.literal("deleted"),
  message: z.string(),
});

export const SendOrDraftOutputSchema = z.object({
  messageId: z.string(),
  draftId: z.string().optional(),
  action: z.enum(["sent", "drafted"]),
  threadId: z.string().optional(),
  // True when this response is an idempotent replay: the send was already
  // recorded under the caller's idempotencyKey and no new email was sent.
  idempotent_replay: z.boolean().optional(),
});

export const SendDraftOutputSchema = z.object({
  draftId: z.string(),
  messageId: z.string(),
  threadId: z.string().optional(),
  status: z.literal("sent"),
});

export const UpdateDraftOutputSchema = z.object({
  draftId: z.string(),
  messageId: z.string().optional(),
  threadId: z.string().optional(),
  status: z.literal("updated"),
});

export const DeleteDraftOutputSchema = z.object({
  draftId: z.string(),
  status: z.literal("deleted"),
});

const DraftSummarySchema = z.object({
  draftId: z.string(),
  messageId: z.string(),
  threadId: z.string().optional(),
  subject: z.string(),
  from: z.string(),
  /** Parsed To recipients (raw address strings, comma-split). */
  to: z.array(z.string()),
  date: z.string(),
  snippet: z.string(),
});

export const ListDraftsOutputSchema = z.object({
  resultCount: z.number(),
  drafts: z.array(DraftSummarySchema),
  /** Gmail's nextPageToken — pass back as pageToken to fetch the next page. */
  nextPageToken: z.string().optional(),
  /** Gmail's server-side estimate of the total draft count. */
  resultSizeEstimate: z.number().optional(),
  /** True if more drafts exist server-side than were returned here. */
  truncated: z.boolean(),
  /** Best-effort total matching draft count (Gmail's estimate). */
  total_available: z.number(),
});

export const ReportPhishingOutputSchema = z.object({
  messageId: z.string(),
  labelApplied: z.literal("SPAM"),
  status: z.literal("reported_as_spam"),
  limitation: z.string(),
});

export const ReplyAllOutputSchema = z.object({
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  threadId: z.string(),
  inReplyTo: z.string(),
  /** The send-as identity the reply was sent from, when a closer identity than
      the account default was chosen (or an explicit `from` was given). Null
      when the account default send-as was used. */
  fromIdentity: z.string().nullable(),
  /** True when the caller's idempotencyKey matched a previous reply_all send
      and no new email was sent. */
  idempotent_replay: z.boolean().optional(),
});

export const ModifyOrDeleteEmailOutputSchema = z.object({
  messageId: z.string(),
  status: z.enum(["modified", "deleted"]),
});

export const ModifyThreadOutputSchema = z.object({
  threadId: z.string(),
  status: z.literal("modified"),
});

export const BatchOpOutputSchema = z.object({
  action: z.enum(["modify", "delete", "report_phishing"]),
  successCount: z.number(),
  failureCount: z.number(),
  failures: z.array(
    z.object({
      messageId: z.string(),
      error: z.string(),
      // 0-based index of the batch the item belonged to, so callers can
      // correlate failures with progress ("batch 3 of 12 failed").
      batchIndex: z.number().optional(),
    }),
  ),
  // Partial-failure diagnostics: which batches ran and whether the run was
  // cut short by client cancellation. Optional for wire compatibility with
  // older clients; always present on current servers.
  batchesTotal: z.number().optional(),
  batchesCompleted: z.number().optional(),
  itemsTotal: z.number().optional(),
  aborted: z.boolean().optional(),
});

export const DownloadEmailOutputSchema = z.object({
  status: z.literal("saved"),
  path: z.string(),
  size: z.number(),
  messageId: z.string(),
  subject: z.string(),
  from: z.string(),
  date: z.string(),
  format: z.enum(["json", "eml", "txt", "html"]),
  attachments: z.array(AttachmentMetaSchema),
});

export const DownloadAttachmentOutputSchema = z.object({
  status: z.literal("saved"),
  path: z.string(),
  filename: z.string(),
  size: z.number(),
  messageId: z.string(),
  attachmentId: z.string(),
});

export const HealthCheckOutputSchema = z.object({
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  issues: z.array(z.string()),
  uptime_s: z.number(),
  pid: z.number(),
  node: z.string(),
  heap_mb: z.number(),
  rss_mb: z.number(),
  event_loop_p99_ms: z.number(),
  event_loop_max_ms: z.number(),
  tool_calls: z.number(),
  recent_errors: z.number(),
  last_activity_age_s: z.number(),
});

const AccountListEntrySchema = z.object({
  id: z.string(),
  emailAddress: z.string().nullable(),
  scopes: z.array(z.string()).nullable(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.string().nullable(),
});

export const ListAccountsOutputSchema = z.object({
  active: z.object({
    id: z.string().nullable(),
    source: z.enum(["flag", "env", "manifest-default", "manifest-sole", "legacy-implicit", "none"]),
    isLegacyImplicit: z.boolean(),
  }),
  count: z.number(),
  accounts: z.array(AccountListEntrySchema),
  /** The account list is local and fully enumerated, so this is always false. */
  truncated: z.boolean(),
  /** Total accounts returned (equals count). */
  total_available: z.number(),
});

export const SwitchAccountOutputSchema = z.object({
  previousAccountId: z.string().nullable(),
  newAccountId: z.string(),
  emailAddress: z.string().nullable(),
  scopes: z.array(z.string()),
  note: z.string().optional(),
});

export const UnreadSummaryAccountSchema = z.object({
  id: z.string(),
  emailAddress: z.string().nullable(),
  /** Unread messages in the inbox (INBOX label messagesUnread), or null if unavailable. */
  unreadInbox: z.number().nullable(),
  /** Total unread messages account-wide (UNREAD label messagesUnread), or null. */
  unreadTotal: z.number().nullable(),
  /** Set when this account's query failed (build/credentials/API error). */
  error: z.string().optional(),
  /** Set when the account was skipped (e.g. stored scopes lack read access). */
  skippedReason: z.string().optional(),
  /** Present only when includeSamples was requested. */
  samples: z
    .array(
      z.object({
        id: z.string(),
        from: z.string().nullable(),
        subject: z.string().nullable(),
        date: z.string().nullable(),
      }),
    )
    .optional(),
});

export const UnreadSummaryOutputSchema = z.object({
  /** The active account id at call time — unchanged by this tool. */
  activeAccountId: z.string().nullable(),
  /** Sum of unreadInbox across all included accounts. */
  totalUnread: z.number(),
  accounts: z.array(UnreadSummaryAccountSchema),
  /** The account list is local + fully enumerated, so this is always false. */
  truncated: z.boolean(),
  /** Total accounts returned (equals accounts.length). */
  total_available: z.number(),
});

// Tool definition type
export interface ToolAnnotations {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType<any>;
  scopes: string[]; // Any of these scopes grants access
  annotations: ToolAnnotations;
  /**
   * When true, the tool is hidden from the MCP surface: excluded from
   * tools/list and rejected by the MCP CallTool handler. The op stays in
   * the operation registry, so in-process callers (CLI, TUI) can still
   * dispatch it by name. Used for account meta-tools that must not be
   * network-reachable (security: a remote MCP client must not be able to
   * enumerate or switch the server's Gmail accounts).
   */
  mcpHidden?: boolean;
}

// Tool registry with scope requirements
export const toolDefinitions: ToolDefinition[] = [
  // Read-only email operations
  {
    name: "read_email",
    description: "Retrieves the content of a specific email",
    schema: ReadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Read Email", readOnlyHint: true },
  },
  {
    name: "search_emails",
    description: "Searches for emails using Gmail search syntax",
    schema: SearchEmailsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Search Emails", readOnlyHint: true },
  },
  {
    name: "download_attachment",
    description: "Downloads an email attachment to a specified location",
    schema: DownloadAttachmentSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Download Attachment", readOnlyHint: true },
  },

  // Thread-level operations
  {
    name: "get_thread",
    description:
      "Retrieves all messages in an email thread in one call. Returns messages ordered chronologically (oldest first) with full content, headers, labels, and attachment metadata.",
    schema: GetThreadSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Thread", readOnlyHint: true },
  },
  {
    name: "list_inbox_threads",
    description:
      "Lists email threads matching a query (default: inbox). Returns thread-level view with snippet, message count, and latest message metadata.",
    schema: ListInboxThreadsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "List Inbox Threads", readOnlyHint: true },
  },
  {
    name: "get_inbox_with_threads",
    description:
      "Convenience tool that lists threads and optionally expands each with full message content. One call returns the full inbox with complete thread bodies.",
    schema: GetInboxWithThreadsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Inbox with Threads", readOnlyHint: true },
  },
  {
    name: "modify_thread",
    description:
      "Modifies labels on ALL messages in a thread atomically using the Gmail threads.modify endpoint. Use this instead of modify_email when you want to apply label changes (e.g., archive, mark as read) to an entire thread at once.",
    schema: ModifyThreadSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Modify Thread", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "download_email",
    description:
      "Downloads an email to a file in various formats (json, eml, txt, html). Returns metadata only - useful for saving emails without consuming context.",
    schema: DownloadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Download Email", readOnlyHint: true },
  },

  // Email write operations
  {
    name: "send_email",
    description: "Sends a new email with optional attachments and inline CID images",
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Send Email", destructiveHint: false },
  },
  {
    name: "draft_email",
    description: "Creates a draft email with optional attachments and inline CID images",
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Draft Email", destructiveHint: false },
  },
  {
    name: "send_draft",
    description: "Sends an existing draft atomically and removes it from Drafts",
    schema: SendDraftSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Send Draft", destructiveHint: false },
  },
  {
    name: "update_draft",
    description: "Replaces an existing draft's content while preserving its draft ID",
    schema: UpdateDraftSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Update Draft", destructiveHint: false },
  },
  {
    name: "delete_draft",
    description: "Deletes an existing draft",
    schema: DeleteDraftSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Delete Draft", destructiveHint: true },
  },
  {
    name: "list_drafts",
    description:
      "Lists saved Gmail drafts with subject, recipients, thread id, and snippet. Read-only; use the returned draftId with update_draft / send_draft / delete_draft.",
    schema: ListDraftsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "List Drafts", readOnlyHint: true },
  },
  {
    name: "modify_email",
    description: "Modifies email labels (move to different folders)",
    schema: ModifyEmailSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Modify Email", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "delete_email",
    description:
      "Permanently deletes an email. Requires gmail.full because gmail.modify does not authorize permanent deletion.",
    schema: DeleteEmailSchema,
    scopes: ["gmail.full"],
    annotations: { title: "Delete Email", destructiveHint: true },
  },
  {
    name: "batch_modify_emails",
    description: "Modifies labels for multiple emails in batches",
    schema: BatchModifyEmailsSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Batch Modify Emails", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "batch_delete_emails",
    description:
      "Permanently deletes multiple emails in batches. Requires gmail.full because gmail.modify does not authorize permanent deletion.",
    schema: BatchDeleteEmailsSchema,
    scopes: ["gmail.full"],
    annotations: { title: "Batch Delete Emails", destructiveHint: true },
  },
  {
    name: "report_phishing",
    description:
      "Applies the SPAM label as the closest public Gmail API approximation of reporting phishing; Gmail exposes no native report-phishing endpoint",
    schema: ReportPhishingSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Report Phishing", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "batch_report_phishing",
    description:
      "Applies the SPAM label to multiple messages as the closest public Gmail API approximation of reporting phishing",
    schema: BatchReportPhishingSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Batch Report Phishing", destructiveHint: true, idempotentHint: true },
  },

  // Label operations
  {
    name: "list_email_labels",
    description: "Retrieves all available Gmail labels",
    schema: ListEmailLabelsSchema,
    scopes: ["gmail.readonly", "gmail.modify", "gmail.labels"],
    annotations: { title: "List Email Labels", readOnlyHint: true },
  },
  {
    name: "create_label",
    description: "Creates a new Gmail label",
    schema: CreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Create Label", destructiveHint: false },
  },
  {
    name: "update_label",
    description: "Updates an existing Gmail label",
    schema: UpdateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Update Label", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "delete_label",
    description: "Deletes a Gmail label",
    schema: DeleteLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Delete Label", destructiveHint: true },
  },
  {
    name: "get_or_create_label",
    description: "Gets an existing label by name or creates it if it doesn't exist",
    schema: GetOrCreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Get or Create Label", destructiveHint: false, idempotentHint: true },
  },

  // Filter operations (require settings scope)
  {
    name: "list_filters",
    description: "Retrieves all Gmail filters",
    schema: ListFiltersSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "List Filters", readOnlyHint: true },
  },
  {
    name: "list_send_identities",
    description:
      "Lists send-as identities (aliases), forwarding addresses, and inbound routing filters. Surfaces catch-all/forwarding setups so an agent can send as, or reply from, the right identity.",
    schema: ListSendIdentitiesSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "List Send Identities", readOnlyHint: true },
  },
  {
    name: "get_filter",
    description: "Gets details of a specific Gmail filter",
    schema: GetFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Get Filter", readOnlyHint: true },
  },
  {
    name: "create_filter",
    description: "Creates a new Gmail filter with custom criteria and actions",
    schema: CreateFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Create Filter", destructiveHint: false },
  },
  {
    name: "delete_filter",
    description: "Deletes a Gmail filter",
    schema: DeleteFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Delete Filter", destructiveHint: true },
  },
  {
    name: "create_filter_from_template",
    description: "Creates a filter using a pre-defined template for common scenarios",
    schema: CreateFilterFromTemplateSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Create Filter from Template", destructiveHint: false },
  },

  // Reply-all operation
  {
    name: "reply_all",
    description:
      "Replies to all recipients of an email. Automatically fetches the original email to build the recipient list (To, CC) and sets proper threading headers.",
    schema: ReplyAllSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Reply All", destructiveHint: false },
  },

  // Robustness — no Gmail scope required
  {
    name: "health_check",
    description:
      "Returns server health metrics (uptime, memory, event-loop p99, tool call count, recent errors). Does not call the Gmail API — usable as a fast canary even when Gmail is unreachable.",
    schema: HealthCheckSchema,
    scopes: [], // empty = always available (see hasScope)
    annotations: { title: "Health Check", readOnlyHint: true },
  },

  // Multi-account meta-tools — hidden from the MCP network surface
  // (mcpHidden): a remote MCP client must not enumerate or switch the
  // server's Gmail accounts. They stay registered in the operation registry
  // so the in-process CLI/TUI can dispatch them by name.
  {
    name: "list_accounts",
    description:
      "Lists Gmail accounts available on this server (from the local manifest) and identifies which one is currently active. Read-only; does not call Gmail. Use this before `switch_account` to discover valid ids.",
    schema: ListAccountsSchema,
    scopes: [],
    mcpHidden: true,
    annotations: { title: "List Gmail Accounts", readOnlyHint: true },
  },
  {
    name: "switch_account",
    description:
      "Switches the active Gmail account for subsequent tool calls. The new account's credentials must already exist on disk — run `gmail account auth <id>` from the shell first, or call `list_accounts` to find an existing one. Note: the tool catalogue advertised via tools/list does NOT refresh automatically; if the new account has narrower scopes than the previous one, some tool calls may reject at call-time with a re-auth hint. Treat as a write/state-change operation that hosts can permission-gate.",
    schema: SwitchAccountSchema,
    scopes: [],
    mcpHidden: true,
    annotations: { title: "Switch Gmail Account", destructiveHint: false, idempotentHint: false },
  },
  {
    name: "unread_summary",
    description:
      "Read-only summary of unread mail across ALL configured Gmail accounts. Returns per-account unread counts (inbox + total) plus an aggregate, without changing the active account (no switch needed). Accounts whose stored scopes lack read access are skipped. Cheap: one labels.get per account; set includeSamples for up to 5 sample unread subjects per account.",
    schema: UnreadSummarySchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Unread Summary (All Accounts)", readOnlyHint: true },
  },
];

// Convert tool definitions to MCP tool format.
// Cast to any keeps TypeScript from chasing zod 3.25+'s deep generics, which
// otherwise hit "Type instantiation is excessively deep" on this call.
// The JSON schema output is dynamically validated by MCP clients regardless.
export function toMcpTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.schema as any),
    annotations: tool.annotations,
  }));
}

// Get a tool definition by name
export function getToolByName(name: string): ToolDefinition | undefined {
  return toolDefinitions.find((t) => t.name === name);
}
