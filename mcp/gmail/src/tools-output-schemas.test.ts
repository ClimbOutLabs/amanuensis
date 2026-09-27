// Parameterized smoke tests for every Phase B2 output schema in src/tools.ts.
//
// For each schema we assert that a minimal-valid sample parses successfully
// and that a clearly-malformed sample (missing required field or wrong type)
// is rejected. The discriminated union (`GetInboxWithThreadsOutputSchema`)
// is exercised with both arms.

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  BatchOpOutputSchema,
  CreateFilterOutputSchema,
  DeleteFilterOutputSchema,
  DownloadAttachmentOutputSchema,
  DownloadEmailOutputSchema,
  GetFilterOutputSchema,
  GetInboxWithThreadsOutputSchema,
  GetThreadOutputSchema,
  HealthCheckOutputSchema,
  LabelDeleteOutputSchema,
  LabelMutationOutputSchema,
  ListAccountsOutputSchema,
  ListEmailLabelsOutputSchema,
  ListFiltersOutputSchema,
  ListInboxThreadsOutputSchema,
  ListSendIdentitiesOutputSchema,
  ModifyOrDeleteEmailOutputSchema,
  ModifyThreadOutputSchema,
  ReadEmailOutputSchema,
  ReplyAllOutputSchema,
  SearchEmailsOutputSchema,
  SendOrDraftOutputSchema,
  SwitchAccountOutputSchema,
  UnreadSummaryOutputSchema,
} from "./tools.js";

type SchemaCase = {
  name: string;
  schema: z.ZodTypeAny;
  valid: unknown;
  invalid: unknown;
};

const threadSummary = {
  threadId: "t1",
  snippet: "snip",
  historyId: "h1",
  messageCount: 1,
  latestMessage: { from: "a@example.com", subject: "hi", date: "2024-01-01" },
};

const threadMessageSummary = {
  messageId: "m1",
  threadId: "t1",
  from: "a@example.com",
  to: "b@example.com",
  cc: "",
  bcc: "",
  subject: "hi",
  date: "2024-01-01",
  body: "body",
  labelIds: ["INBOX"],
  attachments: [{ filename: "f.txt", mimeType: "text/plain", size: 4 }],
};

const cases: SchemaCase[] = [
  {
    name: "SearchEmailsOutputSchema",
    schema: SearchEmailsOutputSchema,
    valid: {
      resultCount: 1,
      truncated: false,
      total_available: 1,
      results: [
        {
          id: "abc",
          threadId: "t-abc",
          subject: "s",
          from: "Sender <f@example.com>",
          fromAddress: { name: "Sender", email: "f@example.com" },
          to: [{ name: "", email: "me@example.com" }],
          cc: [],
          date: "2024-01-01",
        },
      ],
    },
    // resultCount must be a number
    invalid: { resultCount: "1", results: [] },
  },
  {
    name: "ReadEmailOutputSchema",
    schema: ReadEmailOutputSchema,
    valid: {
      messageId: "m1",
      threadId: "t1",
      subject: "s",
      from: "a@example.com",
      to: "b@example.com",
      cc: "",
      bcc: "",
      date: "2024-01-01",
      rfcMessageId: "<rfc@id>",
      body: "body",
      bodyText: "body",
      bodyHtml: "",
      attachments: [{ filename: "a.txt", mimeType: "text/plain", size: 1 }],
    },
    // missing required `attachments`
    invalid: {
      messageId: "m1",
      threadId: "t1",
      subject: "s",
      from: "a",
      to: "b",
      date: "d",
      rfcMessageId: "r",
      body: "",
      bodyText: "",
      bodyHtml: "",
    },
  },
  {
    name: "GetThreadOutputSchema",
    schema: GetThreadOutputSchema,
    valid: {
      threadId: "t1",
      messageCount: 1,
      messages: [threadMessageSummary],
      truncated: false,
      total_available: 1,
    },
    // messages must be an array
    invalid: { threadId: "t1", messageCount: 1, messages: threadMessageSummary },
  },
  {
    name: "ListInboxThreadsOutputSchema",
    schema: ListInboxThreadsOutputSchema,
    valid: { resultCount: 1, threads: [threadSummary], truncated: false, total_available: 1 },
    // missing threads
    invalid: { resultCount: 1 },
  },
  {
    name: "GetInboxWithThreadsOutputSchema (summary arm)",
    schema: GetInboxWithThreadsOutputSchema,
    valid: { resultCount: 1, threads: [threadSummary], truncated: false, total_available: 1 },
    // neither arm: missing both threadId and required summary fields
    invalid: { resultCount: 1, threads: [{ foo: "bar" }] },
  },
  {
    name: "GetInboxWithThreadsOutputSchema (expanded arm)",
    schema: GetInboxWithThreadsOutputSchema,
    valid: {
      resultCount: 1,
      threads: [{ threadId: "t1", messageCount: 1, messages: [threadMessageSummary] }],
      truncated: false,
      total_available: 1,
    },
    // resultCount missing
    invalid: { threads: [] },
  },
  {
    name: "ListEmailLabelsOutputSchema",
    schema: ListEmailLabelsOutputSchema,
    valid: {
      count: { total: 1, system: 1, user: 0 },
      system: [{ id: "INBOX", name: "INBOX", type: "system" }],
      user: [],
      truncated: false,
      total_available: 1,
    },
    // count.total missing
    invalid: { count: { system: 1, user: 0 }, system: [], user: [] },
  },
  {
    name: "LabelMutationOutputSchema",
    schema: LabelMutationOutputSchema,
    valid: { id: "L1", name: "Work", type: "user" },
    // type required (no `.optional()` here)
    invalid: { id: "L1", name: "Work" },
  },
  {
    name: "LabelDeleteOutputSchema",
    schema: LabelDeleteOutputSchema,
    valid: { id: "L1", status: "deleted", message: "ok" },
    // status literal "deleted" only
    invalid: { id: "L1", status: "removed", message: "ok" },
  },
  {
    name: "ListFiltersOutputSchema",
    schema: ListFiltersOutputSchema,
    valid: {
      count: 1,
      filters: [{ id: "f1", criteria: { from: "x" }, action: { addLabelIds: ["L1"] } }],
      truncated: false,
      total_available: 1,
    },
    // count must be a number
    invalid: { count: "1", filters: [] },
  },
  {
    name: "GetFilterOutputSchema",
    schema: GetFilterOutputSchema,
    valid: { id: "f1", criteria: { from: "x" }, action: { addLabelIds: ["L1"] } },
    // id required
    invalid: { criteria: {}, action: {} },
  },
  {
    name: "ListSendIdentitiesOutputSchema",
    schema: ListSendIdentitiesOutputSchema,
    valid: {
      sendAsIdentities: [
        {
          email: "me@example.com",
          displayName: null,
          isDefault: true,
          isPrimary: true,
          treatAsAlias: false,
          verificationStatus: null,
        },
      ],
      forwardingAddresses: [],
      inboundRoutingFilters: [
        {
          id: "f1",
          to: "team@example.com",
          from: null,
          query: null,
          addLabelIds: ["Label_1"],
          removeLabelIds: [],
          forward: null,
        },
      ],
      truncated: false,
      total_available: 1,
    },
    // sendAsIdentities must be an array
    invalid: { sendAsIdentities: {}, forwardingAddresses: [], inboundRoutingFilters: [] },
  },
  {
    name: "CreateFilterOutputSchema",
    schema: CreateFilterOutputSchema,
    valid: { id: "f1", criteria: { from: "x" }, action: { addLabelIds: ["L1"] } },
    // criteria/action required (not optional like FilterEntrySchema)
    invalid: { id: "f1" },
  },
  {
    name: "DeleteFilterOutputSchema",
    schema: DeleteFilterOutputSchema,
    valid: { id: "f1", status: "deleted", message: "ok" },
    invalid: { id: "f1", status: "gone", message: "ok" },
  },
  {
    name: "SendOrDraftOutputSchema",
    schema: SendOrDraftOutputSchema,
    valid: { messageId: "m1", action: "sent", threadId: "t1" },
    // action must be one of "sent"|"drafted"
    invalid: { messageId: "m1", action: "queued" },
  },
  {
    name: "ReplyAllOutputSchema",
    schema: ReplyAllOutputSchema,
    valid: {
      to: ["a@example.com"],
      cc: [],
      subject: "Re: hi",
      threadId: "t1",
      inReplyTo: "<rfc@id>",
      fromIdentity: null,
    },
    // to must be an array
    invalid: {
      to: "a@example.com",
      cc: [],
      subject: "Re: hi",
      threadId: "t1",
      inReplyTo: "<rfc@id>",
      fromIdentity: null,
    },
  },
  {
    name: "ModifyOrDeleteEmailOutputSchema",
    schema: ModifyOrDeleteEmailOutputSchema,
    valid: { messageId: "m1", status: "modified" },
    invalid: { messageId: "m1", status: "frobnicated" },
  },
  {
    name: "ModifyThreadOutputSchema",
    schema: ModifyThreadOutputSchema,
    valid: { threadId: "t1", status: "modified" },
    invalid: { threadId: "t1", status: "deleted" },
  },
  {
    name: "BatchOpOutputSchema",
    schema: BatchOpOutputSchema,
    valid: {
      action: "modify",
      successCount: 2,
      failureCount: 1,
      failures: [{ messageId: "m1", error: "boom" }],
    },
    // failures items need both messageId and error
    invalid: {
      action: "modify",
      successCount: 2,
      failureCount: 1,
      failures: [{ messageId: "m1" }],
    },
  },
  {
    name: "DownloadEmailOutputSchema",
    schema: DownloadEmailOutputSchema,
    valid: {
      status: "saved",
      path: "/tmp/m1.eml",
      size: 123,
      messageId: "m1",
      subject: "s",
      from: "a@example.com",
      date: "2024-01-01",
      format: "eml",
      attachments: [],
    },
    // format must be json|eml|txt|html
    invalid: {
      status: "saved",
      path: "/tmp/m1.eml",
      size: 123,
      messageId: "m1",
      subject: "s",
      from: "a@example.com",
      date: "2024-01-01",
      format: "pdf",
      attachments: [],
    },
  },
  {
    name: "DownloadAttachmentOutputSchema",
    schema: DownloadAttachmentOutputSchema,
    valid: {
      status: "saved",
      path: "/tmp/a.txt",
      filename: "a.txt",
      size: 4,
      messageId: "m1",
      attachmentId: "att1",
    },
    // size must be a number
    invalid: {
      status: "saved",
      path: "/tmp/a.txt",
      filename: "a.txt",
      size: "4",
      messageId: "m1",
      attachmentId: "att1",
    },
  },
  {
    name: "HealthCheckOutputSchema",
    schema: HealthCheckOutputSchema,
    valid: {
      status: "healthy",
      issues: [],
      uptime_s: 10,
      pid: 1,
      node: "v20.0.0",
      heap_mb: 100,
      rss_mb: 200,
      event_loop_p99_ms: 1,
      event_loop_max_ms: 2,
      tool_calls: 0,
      recent_errors: 0,
      last_activity_age_s: 0,
    },
    // status enum mismatch
    invalid: {
      status: "fine",
      issues: [],
      uptime_s: 10,
      pid: 1,
      node: "v20.0.0",
      heap_mb: 100,
      rss_mb: 200,
      event_loop_p99_ms: 1,
      event_loop_max_ms: 2,
      tool_calls: 0,
      recent_errors: 0,
      last_activity_age_s: 0,
    },
  },
  {
    name: "ListAccountsOutputSchema",
    schema: ListAccountsOutputSchema,
    valid: {
      active: { id: "work", source: "manifest-default", isLegacyImplicit: false },
      count: 1,
      truncated: false,
      total_available: 1,
      accounts: [
        {
          id: "work",
          emailAddress: "w@example.com",
          scopes: ["gmail.modify"],
          isDefault: true,
          isActive: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    // source enum mismatch
    invalid: {
      active: { id: "work", source: "bogus", isLegacyImplicit: false },
      count: 0,
      accounts: [],
    },
  },
  {
    name: "SwitchAccountOutputSchema",
    schema: SwitchAccountOutputSchema,
    valid: {
      previousAccountId: "work",
      newAccountId: "personal",
      emailAddress: "p@example.com",
      scopes: ["gmail.readonly"],
      note: "swapped",
    },
    // newAccountId required
    invalid: {
      previousAccountId: "work",
      emailAddress: null,
      scopes: [],
    },
  },
  {
    name: "UnreadSummaryOutputSchema",
    schema: UnreadSummaryOutputSchema,
    valid: {
      activeAccountId: "work",
      totalUnread: 4,
      truncated: false,
      total_available: 2,
      accounts: [
        { id: "work", emailAddress: "w@example.com", unreadInbox: 3, unreadTotal: 5 },
        {
          id: "personal",
          emailAddress: null,
          unreadInbox: null,
          unreadTotal: null,
          skippedReason: "no read scope",
        },
      ],
    },
    // totalUnread must be a number
    invalid: {
      activeAccountId: null,
      totalUnread: "lots",
      truncated: false,
      total_available: 0,
      accounts: [],
    },
  },
];

describe("output schemas (Phase B2)", () => {
  it.each(cases.map((c) => [c.name, c] as const))(
    "%s accepts minimal-valid payload",
    (_name, c) => {
      expect(() => c.schema.parse(c.valid)).not.toThrow();
    },
  );

  it.each(cases.map((c) => [c.name, c] as const))("%s rejects malformed payload", (_name, c) => {
    expect(() => c.schema.parse(c.invalid)).toThrow();
  });
});
