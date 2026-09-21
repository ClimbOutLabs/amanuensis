import { describe, expect, it } from "vitest";
import {
  BATCH_MESSAGE_IDS_MAX,
  BatchDeleteEmailsSchema,
  BatchModifyEmailsSchema,
} from "./tools.js";

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `msg-${i}`);
}

describe("BatchModifyEmailsSchema messageIds cap", () => {
  it("accepts exactly the cap", () => {
    expect(() =>
      BatchModifyEmailsSchema.parse({ messageIds: ids(BATCH_MESSAGE_IDS_MAX) }),
    ).not.toThrow();
  });

  it("rejects one over the cap", () => {
    expect(() =>
      BatchModifyEmailsSchema.parse({ messageIds: ids(BATCH_MESSAGE_IDS_MAX + 1) }),
    ).toThrow(/messageIds/);
  });

  it("accepts a small batch", () => {
    const parsed = BatchModifyEmailsSchema.parse({
      messageIds: ["a", "b", "c"],
      addLabelIds: ["L1"],
    });
    expect(parsed.messageIds).toHaveLength(3);
  });
});

describe("BatchDeleteEmailsSchema messageIds cap", () => {
  it("accepts exactly the cap", () => {
    expect(() =>
      BatchDeleteEmailsSchema.parse({ messageIds: ids(BATCH_MESSAGE_IDS_MAX) }),
    ).not.toThrow();
  });

  it("rejects one over the cap", () => {
    expect(() =>
      BatchDeleteEmailsSchema.parse({ messageIds: ids(BATCH_MESSAGE_IDS_MAX + 1) }),
    ).toThrow(/messageIds/);
  });
});
