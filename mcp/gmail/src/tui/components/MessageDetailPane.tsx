import { Box, Text, useStdout } from "ink";
import { memo } from "react";
import type { ThreadView } from "../reducer.js";
import type { Theme } from "../themes/index.js";
import { normalize, senderColor, senderDisplayName } from "../util/sender-color.js";

interface Props {
  thread: ThreadView | null;
  cursor: number;
  focused: boolean;
  theme: Theme;
  /** Number of body lines hidden above the visible window (j/k/Ctrl-d scroll). */
  bodyScroll: number;
  /** Outer pane width including border + padding. Source of truth lives
      in App.tsx's responsive layout helper. */
  width?: number;
}

// Full-body single-message view — the rightmost drill-down pane. Renders
// every line of the body as its own `<Text>` with an explicit
// `backgroundColor` so cell content from the previous frame can't leak
// through Ink 7's diff renderer (the same `Box backgroundColor` no-op that
// hit the modals — this pane lives outside the modal takeover so it has
// to defend itself).

function MessageDetailPaneImpl({ thread, cursor, focused, theme, bodyScroll, width }: Props) {
  const { stdout } = useStdout();
  // Reserve ~9 rows for borders + header block + spacer + status bar + helpbar.
  // The remaining vertical real estate is the body viewport. With a 50-row
  // terminal that's typically 41 body lines visible at once.
  const terminalRows = stdout?.rows ?? 50;
  const bodyViewportRows = Math.max(6, terminalRows - 9);
  // `paneInner` is the row-content width inside the pane's border+padding.
  // Driven by the `width` prop (responsive layout helper); falls back to a
  // best-effort derivation when no width was supplied — useful for unit
  // tests that render the component in isolation.
  const paneOuter = width ?? Math.max(60, (stdout?.columns ?? 180) - 66);
  const paneInner = Math.max(40, paneOuter - 4);
  if (!thread || thread.messages.length === 0) {
    return (
      <Box
        flexDirection="column"
        {...(width ? { width, flexShrink: 0 } : { flexGrow: 1 })}
        paddingX={1}
        paddingY={1}
        borderStyle="single"
        borderColor={focused ? theme.accent : theme.border}
      >
        <Text color={theme.dim}>(no message selected — press l on a thread)</Text>
      </Box>
    );
  }
  const idx = Math.min(Math.max(0, cursor), thread.messages.length - 1);
  const msg = thread.messages[idx];
  if (!msg) {
    return (
      <Box
        flexDirection="column"
        {...(width ? { width, flexShrink: 0 } : { flexGrow: 1 })}
        paddingX={1}
        paddingY={1}
        borderStyle="single"
        borderColor={focused ? theme.accent : theme.border}
      >
        <Text color={theme.dim}>(message not found)</Text>
      </Box>
    );
  }
  const accountTag =
    "accountId" in msg && msg.accountId
      ? ` [${msg.accountId}${msg.emailAddress ? ` <${msg.emailAddress}>` : ""}]`
      : "";
  const senderHue = senderColor(theme, msg.from);
  const fromAddr = normalize(msg.from);
  const fromName = senderDisplayName(msg.from);
  const allBodyLines = (msg.body || "").split(/\r?\n/);
  const totalBodyLines = allBodyLines.length;
  // Clamp the scroll: if the message has shrunk under us, snap to the last
  // possible "page-top" rather than rendering past the end.
  const maxScroll = Math.max(0, totalBodyLines - bodyViewportRows);
  const clampedScroll = Math.min(Math.max(0, bodyScroll), maxScroll);
  const bodyLines = allBodyLines.slice(clampedScroll, clampedScroll + bodyViewportRows);
  // Scroll indicator — shown only when the body actually overflows. Mirrors
  // vim's `↓ <line>/<total>` status line; less.
  const scrollIndicator =
    totalBodyLines > bodyViewportRows
      ? ` · body ${clampedScroll + 1}–${Math.min(clampedScroll + bodyLines.length, totalBodyLines)} / ${totalBodyLines}`
      : "";
  return (
    <Box
      flexDirection="column"
      {...(width ? { width, flexShrink: 0 } : { flexGrow: 1 })}
      paddingX={1}
      borderStyle="single"
      borderColor={focused ? theme.accent : theme.border}
    >
      {/* Explicit spacer row instead of paddingY — when paddingY is set, the
          first child Row mysteriously fails to render under Ink 7's flex
          column layout (root cause unclear; appears related to padding-box
          collapsing with the first text node). The spacer Row also has a
          backgroundColor write to keep the bleed contract intact. */}
      <Row theme={theme} color={theme.dim} width={paneInner}>
        {" "}
      </Row>
      {/* Subject wraps freely — long subjects span multiple lines so the
          user never sees a `…` truncate. Accent colour so it leads the
          eye. The `wrap="wrap"` engine word-wraps at the pane edge. */}
      <Text color={theme.accent} backgroundColor={theme.bg} wrap="wrap" bold>
        {msg.subject || "(no subject)"}
      </Text>
      <Row theme={theme} color={theme.dim} width={paneInner}>
        {`Message ${idx + 1} of ${thread.messages.length}${accountTag}${scrollIndicator}`}
      </Row>
      <Row theme={theme} color={senderHue} width={paneInner}>
        {`From: ${fromName} <${fromAddr}>`}
      </Row>
      <Row theme={theme} color={theme.dim} width={paneInner}>
        {`Date: ${formatFullDate(msg.date)}`}
      </Row>
      {/* Hairline horizontal separator between the header block and the
          body — gives the eye a clear anchor to skip past metadata when
          scanning a message. Renders in border colour for low-contrast
          aesthetic; the line characters fill every cell in their row so
          there's no bleed risk. */}
      <Text color={theme.border} backgroundColor={theme.bg}>
        {"─".repeat(Math.max(0, paneInner))}
      </Text>
      {/* Body */}
      {bodyLines.length === 0 ? (
        <Row theme={theme} color={theme.dim} width={paneInner}>
          (empty body)
        </Row>
      ) : (
        // Stable key: messageId-scoped offset. Body lines for a given
        // message render in a fixed order, so `${messageId}:<offset>` is
        // stable across rerenders without falling back to the index. We
        // pass `startIndex` so keys reflect the absolute line position
        // even when the user has scrolled — otherwise keys collide as
        // scroll moves a different slice of lines into the visible window.
        bodyLineRows(msg.messageId, bodyLines, theme, paneInner, clampedScroll, allBodyLines)
      )}
      {/* Attachments */}
      {msg.attachments.length > 0 ? (
        <>
          <Box height={1} />
          <Row theme={theme} color={theme.warning} width={paneInner}>
            {`Attachments (${msg.attachments.length}):`}
          </Row>
          {attachmentRows(msg.messageId, msg.attachments, theme, paneInner)}
        </>
      ) : null}
    </Box>
  );
}

// Body line: wraps, no padEnd. The Text's backgroundColor still paints
// every cell in the wrapped lines (Ink applies the bg to the laid-out
// glyphs), so cell-leak defence holds even without the truncate trick.
// We use a Box wrapper to constrain the wrap engine to the pane width.
function BodyRow({
  theme,
  width,
  prefix,
  prefixColor,
  body,
  bodyColor,
}: {
  theme: Theme;
  width: number;
  prefix: string;
  prefixColor: string;
  body: string;
  bodyColor: string;
}) {
  return (
    <Box width={width} flexShrink={0}>
      <Text color={prefixColor} backgroundColor={theme.bg}>
        {prefix}
      </Text>
      <Text color={bodyColor} backgroundColor={theme.bg} wrap="wrap">
        {body}
      </Text>
    </Box>
  );
}

// Pane is widthflex-bound by App.tsx but body text varies wildly. To stop
// prior-frame cell content leaking through (Ink 7's diff renderer doesn't
// paint cells past a row's text length), every row is right-padded with
// spaces to a fixed safe-large width and wrap="truncate" clips it back
// to the visible pane. The bg-colored padding writes every interior cell,
// so the previous frame's content can't peek through anywhere.
//
// Caveat: `bold` is intentionally avoided on header rows — Ink-7 + this
// pane's flex layout drops bold rows entirely under some conditions
// (observed: switching threads where one msg has a long sender address
// renders the subject + From rows as completely blank). Plain text always
// renders.
function Row({
  theme,
  color,
  width,
  children,
}: {
  theme: Theme;
  color: string;
  width: number;
  children: React.ReactNode;
}) {
  // Only string/number children render as text; anything else (elements,
  // arrays) would stringify to "[object Object]".
  const text =
    typeof children === "string" || typeof children === "number" ? String(children) : "";
  return (
    <Text color={color} backgroundColor={theme.bg} wrap="truncate">
      {text.padEnd(width)}
    </Text>
  );
}

// Quoted reply detection — RFC 5322 plain-text reply convention. Three
// signals, evaluated left-to-right per line:
//  1. Lines starting with one or more `>` (with optional whitespace) are
//     literal quoted text — render dim.
//  2. The "On <date>, <name> wrote:" boundary that delimits the
//     forwarded/quoted block — render dim AND set quote mode for every
//     subsequent line in the message (most clients quote-prefix, but
//     iPhone Mail and a handful of others leave the quote unprefixed).
//  3. Signature delimiters (`-- ` per RFC) and standalone "Sent from my
//     iPhone" lines — dim but don't trip quote mode.
function isQuoteMarker(line: string): boolean {
  if (/^\s*>/.test(line)) return true;
  if (/^On\s.+wrote:\s*$/.test(line)) return true;
  return false;
}
function isQuoteBoundary(line: string): boolean {
  return /^On\s.+wrote:\s*$/.test(line);
}
function isSignatureMarker(line: string): boolean {
  if (/^--\s*$/.test(line)) return true;
  if (/^Sent from my (iPhone|iPad|Android|Galaxy)/i.test(line)) return true;
  return false;
}

function bodyLineRows(
  messageId: string,
  lines: string[],
  theme: Theme,
  width: number,
  startIndex: number,
  allLines: string[],
): React.ReactNode {
  // Compute the quote-mode prefix up to startIndex so the boundary
  // detected on a line above the viewport still dims the visible lines.
  let inQuote = false;
  for (let i = 0; i < startIndex && i < allLines.length; i++) {
    if (isQuoteBoundary(allLines[i])) inQuote = true;
  }
  return lines.map((line, i) => {
    const key = `${messageId}:line-${startIndex + i}`;
    // Update mode for THIS line first (the boundary line itself is dim).
    if (isQuoteBoundary(line)) inQuote = true;
    const isQuote = inQuote || isQuoteMarker(line);
    const isSignature = !isQuote && isSignatureMarker(line);
    const dim = isQuote || isSignature;
    // Quoted lines get a Slack/Discord-style left bar marker in border
    // colour so the eye reliably skips past them. Signature lines just
    // dim (no bar — `--` or "Sent from my iPhone" don't represent a
    // multi-line block in the same way). Two-space gutter on regular
    // lines so the body column aligns.
    const prefix = isQuote ? "│ " : "  ";
    const prefixColor = isQuote ? theme.border : theme.fg;
    const bodyColor = dim ? theme.dim : theme.fg;
    return (
      <BodyRow
        key={key}
        theme={theme}
        width={width}
        prefix={prefix}
        prefixColor={prefixColor}
        body={line || " "}
        bodyColor={bodyColor}
      />
    );
  });
}

function attachmentRows(
  messageId: string,
  attachments: Array<{ filename: string; mimeType: string; size: number }>,
  theme: Theme,
  width: number,
): React.ReactNode {
  return attachments.map((a) => {
    // `get_thread` doesn't include the attachment id — only `read_email`
    // does (Phase D2 follow-up). Compose a key from messageId + filename so
    // a re-fetched thread keeps the same React identity per row.
    const key = `${messageId}:${a.filename}`;
    return (
      <Row key={key} theme={theme} color={theme.warning} width={width}>
        {`  · ${a.filename}${a.mimeType ? ` (${a.mimeType})` : ""}${a.size ? ` · ${formatBytes(a.size)}` : ""}`}
      </Row>
    );
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function formatFullDate(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const day = days[d.getDay()];
  const dd = d.getDate().toString().padStart(2, "0");
  const month = months[d.getMonth()];
  const yyyy = d.getFullYear();
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${day}, ${dd} ${month} ${yyyy} ${hh}:${mm}`;
}

export const MessageDetailPane = memo(MessageDetailPaneImpl);
