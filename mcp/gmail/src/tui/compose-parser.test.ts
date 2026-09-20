import { describe, expect, it } from "vitest";
import { buildComposeTemplate, parseCompose, quoteReplyBody } from "./compose-parser.js";

describe("parseCompose", () => {
  it("splits headers from body on the first blank line", () => {
    const raw = "To: a@b.test\nSubject: hi\n\nbody line 1\nbody line 2\n";
    const parsed = parseCompose(raw);
    expect(parsed.to).toEqual(["a@b.test"]);
    expect(parsed.subject).toBe("hi");
    expect(parsed.body).toBe("body line 1\nbody line 2\n");
  });

  it("handles comma-separated recipients with optional whitespace", () => {
    const raw = "To: a@b.test , c@d.test ,e@f.test\n\n";
    const parsed = parseCompose(raw);
    expect(parsed.to).toEqual(["a@b.test", "c@d.test", "e@f.test"]);
  });

  it("preserves display-name recipients (Name <addr>)", () => {
    const raw = "To: Vahid Habibi <vahid.habibi@thebluerock.test>, a@b.test\n\n";
    const parsed = parseCompose(raw);
    expect(parsed.to).toEqual(["Vahid Habibi <vahid.habibi@thebluerock.test>", "a@b.test"]);
  });

  it("does not split on a comma inside a quoted display name", () => {
    const raw = 'To: "Last, First" <lf@example.test>, a@b.test\n\n';
    const parsed = parseCompose(raw);
    // The comma inside the quoted name must not fragment the recipient, and
    // the name is re-quoted so it re-parses unambiguously.
    expect(parsed.to).toEqual(['"Last, First" <lf@example.test>', "a@b.test"]);
  });

  it("falls back to a naive split when the address list is malformed", () => {
    const raw = "To: not an address, a@b.test\n\n";
    const parsed = parseCompose(raw);
    expect(parsed.to).toEqual(["not an address", "a@b.test"]);
  });

  it("ignores empty Cc/Bcc lines without crashing", () => {
    const raw = "To: a@b.test\nCc:\nBcc:\nSubject: hi\n\nbody\n";
    const parsed = parseCompose(raw);
    expect(parsed.cc).toEqual([]);
    expect(parsed.bcc).toEqual([]);
    expect(parsed.body).toBe("body\n");
  });

  it("normalises CRLF line endings before parsing", () => {
    const raw = "To: a@b.test\r\nSubject: hi\r\n\r\nbody\r\n";
    const parsed = parseCompose(raw);
    expect(parsed.subject).toBe("hi");
    expect(parsed.body).toBe("body\n");
  });

  it("treats a malformed header line as start of body (fault-tolerant)", () => {
    const raw = "To: a@b.test\nthis is not a header\nstill body\n";
    const parsed = parseCompose(raw);
    expect(parsed.to).toEqual(["a@b.test"]);
    expect(parsed.body).toBe("this is not a header\nstill body\n");
  });

  it("preserves URLs that contain colons inside the body", () => {
    const raw = "To: a@b.test\nSubject: links\n\nSee https://example.test/path:foo\n";
    const parsed = parseCompose(raw);
    expect(parsed.body).toBe("See https://example.test/path:foo\n");
  });
});

describe("buildComposeTemplate", () => {
  it("emits headers in canonical order with empty defaults", () => {
    expect(buildComposeTemplate({})).toBe("To: \nCc: \nBcc: \nSubject: \n\n");
  });

  it("joins multiple recipients with comma-space", () => {
    const tmpl = buildComposeTemplate({ to: ["a@b.test", "c@d.test"], subject: "hi" });
    expect(tmpl).toContain("To: a@b.test, c@d.test");
    expect(tmpl).toContain("Subject: hi");
  });

  it("omits the X-Gmail-MCP-* headers entirely when no recovery metadata is given", () => {
    const tmpl = buildComposeTemplate({ to: ["a@b.test"], subject: "hi", body: "yo" });
    expect(tmpl).not.toContain("X-Gmail-MCP");
  });

  it("emits X-Gmail-MCP-* breadcrumbs only for the values supplied", () => {
    const tmpl = buildComposeTemplate({
      to: ["a@b.test"],
      subject: "Re: hi",
      body: "quoted",
      kind: "reply-all",
      sourceMessageId: "msg-123",
      sourceThreadId: "thr-456",
    });
    expect(tmpl).toContain("X-Gmail-MCP-Kind: reply-all");
    expect(tmpl).toContain("X-Gmail-MCP-Source-Message-Id: msg-123");
    expect(tmpl).toContain("X-Gmail-MCP-Source-Thread-Id: thr-456");
    // Breadcrumbs sit in the header block, above the body separator.
    expect(tmpl.indexOf("X-Gmail-MCP-Kind")).toBeLessThan(tmpl.indexOf("\n\n"));
  });
});

describe("compose recovery round-trip (build → parse → strip)", () => {
  it("recovers kind + source ids and keeps the X-* headers out of the body", () => {
    const tmpl = buildComposeTemplate({
      to: ["team@fixture.test"],
      subject: "Re: migration",
      body: "I can take the runbook section.",
      kind: "reply-all",
      sourceMessageId: "m-9",
      sourceThreadId: "t-9",
    });
    const parsed = parseCompose(tmpl);
    expect(parsed.to).toEqual(["team@fixture.test"]);
    expect(parsed.subject).toBe("Re: migration");
    expect(parsed.kind).toBe("reply-all");
    expect(parsed.sourceMessageId).toBe("m-9");
    expect(parsed.sourceThreadId).toBe("t-9");
    // The body carries none of the header breadcrumbs — so nothing X-* is sent.
    expect(parsed.body).toBe("I can take the runbook section.");
    expect(parsed.body).not.toContain("X-Gmail-MCP");
  });

  it("leaves recovery fields undefined for a plain compose template", () => {
    const parsed = parseCompose(buildComposeTemplate({ to: ["a@b.test"], subject: "hi" }));
    expect(parsed.kind).toBeUndefined();
    expect(parsed.sourceMessageId).toBeUndefined();
    expect(parsed.sourceThreadId).toBeUndefined();
  });
});

describe("quoteReplyBody", () => {
  it("prepends `On … wrote:` and quotes each line with `> `", () => {
    const out = quoteReplyBody("alice@x.test", "Mon, 1 Jan", "hello\nworld");
    expect(out).toContain("On Mon, 1 Jan, alice@x.test wrote:");
    expect(out).toContain("> hello");
    expect(out).toContain("> world");
  });
});
