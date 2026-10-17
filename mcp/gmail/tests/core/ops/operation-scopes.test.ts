import { describe, expect, it } from "vitest";
import "../../../src/core/ops/drafts.js";
import "../../../src/core/ops/send.js";
import { registry } from "../../../src/core/registry.js";
import { getToolByName } from "../../../src/tools.js";

describe("operation scopes mirror tools.ts", () => {
  it.each([
    "send_email",
    "draft_email",
    "send_draft",
    "update_draft",
    "delete_draft",
    "reply_all",
  ])("%s lists the same scopes in both places", (name) => {
    expect(registry.get(name)?.scopes).toEqual(getToolByName(name)?.scopes);
  });
});
