// Parse a compose file in the .eml-ish format the editor template uses:
//
//   To: a@b.com, c@d.com
//   Cc: e@f.com
//   Bcc:
//   Subject: hello
//
//   body
//   …
//
// First blank line separates headers from body. Header names are
// case-insensitive. Multiple addresses are comma-separated. Whitespace
// around commas is trimmed.

import emailAddresses from "email-addresses";

export interface ParsedCompose {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** Draft-recovery metadata parsed from `X-Gmail-MCP-Kind`, if present. */
  kind?: string;
  /** Source message id parsed from `X-Gmail-MCP-Source-Message-Id`, if present. */
  sourceMessageId?: string;
  /** Source thread id parsed from `X-Gmail-MCP-Source-Thread-Id`, if present. */
  sourceThreadId?: string;
}

export function parseCompose(raw: string): ParsedCompose {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const headers: Record<string, string> = {};
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++; // consume the separator
      break;
    }
    const match = line.match(/^([A-Za-z\-_]+)\s*:\s*(.*)$/);
    if (!match) {
      // Unknown line in the header block — treat as start of body (fault-tolerant).
      break;
    }
    const key = match[1]?.toLowerCase() ?? "";
    const value = match[2]?.trim() ?? "";
    if (key) headers[key] = value;
  }
  const body = lines.slice(i).join("\n");
  // The X-Gmail-MCP-* headers are our own draft-recovery breadcrumbs. They live
  // in the header block (before the first blank line), so they never leak into
  // the body — and since callers rebuild the outgoing message from the parsed
  // to/cc/bcc/subject/body fields (never the raw header lines), the X-* headers
  // are inherently stripped before send. We only lift them back out here so a
  // recovered reply can re-thread onto its original message.
  const parsed: ParsedCompose = {
    to: splitAddrs(headers.to ?? ""),
    cc: splitAddrs(headers.cc ?? ""),
    bcc: splitAddrs(headers.bcc ?? ""),
    subject: headers.subject ?? "",
    body,
  };
  const kind = headers["x-gmail-mcp-kind"];
  const sourceMessageId = headers["x-gmail-mcp-source-message-id"];
  const sourceThreadId = headers["x-gmail-mcp-source-thread-id"];
  if (kind) parsed.kind = kind;
  if (sourceMessageId) parsed.sourceMessageId = sourceMessageId;
  if (sourceThreadId) parsed.sourceThreadId = sourceThreadId;
  return parsed;
}

// Format a parsed mailbox back into a header-safe string. A bare address
// stays bare; a display name is re-quoted only when it contains RFC-5322
// specials (e.g. the comma in "Last, First"), so the reconstructed string
// re-parses unambiguously instead of splitting on the name's comma.
function formatAddress(name: string, address: string): string {
  if (!name) return address;
  const needsQuote = /[",;:<>@()[\]\\]/.test(name);
  const display = needsQuote ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name;
  return `${display} <${address}>`;
}

// Split a comma-separated address header into individual entries. Uses the
// RFC-5322 parser (not a naive comma split) so display names containing
// commas — `"Last, First" <a@b>` — stay intact, and preserves the display
// name so it survives into the sent header. Falls back to a naive split when
// the parser bails on a malformed line, so recipients are never silently
// dropped.
function splitAddrs(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed = emailAddresses.parseAddressList(trimmed);
  if (!parsed) {
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  const out: string[] = [];
  for (const entry of parsed) {
    if (entry.type === "mailbox") {
      out.push(formatAddress(entry.name || "", entry.address));
    } else if (entry.type === "group") {
      // RFC-5322 group syntax ("Team: a@b, c@d;") — flatten to its mailboxes.
      for (const m of entry.addresses) {
        out.push(formatAddress(m.name || "", m.address));
      }
    }
  }
  return out;
}

/** Build a compose template the editor will open with.
 *
 * When `kind` / `sourceMessageId` / `sourceThreadId` are supplied, they are
 * emitted as `X-Gmail-MCP-*` header lines so a locally-persisted `.eml` draft
 * carries enough breadcrumbs to be recovered later and re-threaded correctly.
 * These headers are omitted entirely when their values are absent, so the
 * common `buildComposeTemplate({})` output stays byte-for-byte unchanged. */
export function buildComposeTemplate(opts: {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  kind?: string;
  sourceMessageId?: string;
  sourceThreadId?: string;
}): string {
  const to = (opts.to ?? []).join(", ");
  const cc = (opts.cc ?? []).join(", ");
  const bcc = (opts.bcc ?? []).join(", ");
  const subject = opts.subject ?? "";
  const body = opts.body ?? "";
  let headers = `To: ${to}\nCc: ${cc}\nBcc: ${bcc}\nSubject: ${subject}`;
  if (opts.kind) headers += `\nX-Gmail-MCP-Kind: ${opts.kind}`;
  if (opts.sourceMessageId) headers += `\nX-Gmail-MCP-Source-Message-Id: ${opts.sourceMessageId}`;
  if (opts.sourceThreadId) headers += `\nX-Gmail-MCP-Source-Thread-Id: ${opts.sourceThreadId}`;
  return `${headers}\n\n${body}`;
}

/** Quote a message body for reply context (gmail-style "On X, Y wrote:" header + > prefix). */
export function quoteReplyBody(from: string, date: string, body: string): string {
  const header = `On ${date}, ${from} wrote:`;
  const quoted = body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return `\n\n${header}\n${quoted}\n`;
}
