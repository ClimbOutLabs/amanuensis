import { describe, expect, it } from "vitest";
import { hasScope, DEFAULT_SCOPES, SCOPE_LABELS, SCOPE_MAP, wideScopeNotice } from "../src/scopes.js";
import { toolDefinitions } from "../src/tools.js";

const SEND_TOOLS = ["send_email", "send_draft", "reply_all"];
const DRAFT_TOOLS = ["draft_email", "update_draft", "delete_draft"];
const CHANGE_MAIL_TOOLS = [
  "modify_email",
  "modify_thread",
  "batch_modify_emails",
  "report_phishing",
  "batch_report_phishing",
];

function visible(scopes: string[]): string[] {
  return toolDefinitions.filter((t) => hasScope(scopes, t.scopes)).map((t) => t.name);
}

describe("default connection is read-only", () => {
  it("requests gmail.readonly and nothing else", () => {
    expect(DEFAULT_SCOPES).toEqual(["gmail.readonly"]);
  });

  it("shows read tools but no send, draft or change-mail tools", () => {
    const names = visible(DEFAULT_SCOPES);
    expect(names).toContain("search_emails");
    expect(names).toContain("read_email");
    expect(names).toContain("list_email_labels");
    for (const tool of [...SEND_TOOLS, ...DRAFT_TOOLS, ...CHANGE_MAIL_TOOLS]) {
      expect(names).not.toContain(tool);
    }
  });
});

describe("consent split", () => {
  it("a gmail.modify grant does not expose send or draft tools", () => {
    const names = visible(["gmail.modify"]);
    for (const tool of [...SEND_TOOLS, ...DRAFT_TOOLS]) expect(names).not.toContain(tool);
    for (const tool of CHANGE_MAIL_TOOLS) expect(names).toContain(tool);
  });

  it("send tools need gmail.compose or gmail.send", () => {
    for (const scope of ["gmail.compose", "gmail.send"]) {
      const names = visible([scope]);
      for (const tool of SEND_TOOLS) expect(names).toContain(tool);
    }
  });

  it("no send tool lists gmail.modify or gmail.readonly as sufficient", () => {
    for (const tool of toolDefinitions.filter((t) => SEND_TOOLS.includes(t.name))) {
      expect(tool.scopes).not.toContain("gmail.modify");
      expect(tool.scopes).not.toContain("gmail.readonly");
    }
  });
});

describe("scope labels", () => {
  it("has a label for every scope we can request", () => {
    expect(Object.keys(SCOPE_LABELS).sort()).toEqual(Object.keys(SCOPE_MAP).sort());
  });

  it("says gmail.modify can send and never claims it cannot", () => {
    expect(SCOPE_LABELS["gmail.modify"]).toMatch(/SEND/);
    expect(SCOPE_LABELS["gmail.modify"]).not.toMatch(/no send/i);
  });

  it("describes gmail.readonly as unable to change or send", () => {
    expect(SCOPE_LABELS["gmail.readonly"]).toMatch(/cannot change.*send/i);
  });
});

describe("wideScopeNotice", () => {
  it("is silent for a read-only connection", () => {
    expect(wideScopeNotice({ scopes: ["gmail.readonly"], accountId: "personal" })).toBeNull();
  });

  it("is silent for an explicit send consent", () => {
    expect(wideScopeNotice({ scopes: ["gmail.readonly", "gmail.compose"], accountId: null })).toBeNull();
  });

  it("tells the owner a gmail.modify connection can send and how to reconnect read-only", () => {
    const notice = wideScopeNotice({ scopes: ["gmail.modify"], accountId: "personal" });
    expect(notice).toContain("can send email as you");
    expect(notice).toContain("gmail account auth personal --scopes=gmail.readonly");
  });

  it("recognises full URLs and gmail.full", () => {
    expect(
      wideScopeNotice({
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        accountId: null,
      }),
    ).toContain("gmail.modify");
    expect(wideScopeNotice({ scopes: ["gmail.full"], accountId: null })).toContain("gmail.full");
  });
});
