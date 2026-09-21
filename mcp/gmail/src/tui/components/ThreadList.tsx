import { fitToWidth } from "@george43g/tui-kit";
import { Box, Text } from "ink";
import { memo } from "react";
import type { ThreadList as ThreadListT } from "../reducer.js";
import type { Theme } from "../themes/index.js";

interface Props {
  threads: ThreadListT | null;
  cursor: number;
  focused: boolean;
  theme: Theme;
  title: string;
  /** Outer width including border + padding. */
  width?: number;
  /** Thread id currently loaded in the detail pane — gets a persistent
      accent-bar marker regardless of cursor position or pane focus so the
      user can always see which row is "open" while browsing the list. */
  openThreadId?: string | null;
}

function ThreadListImpl({ threads, cursor, focused, theme, title, width, openThreadId }: Props) {
  return (
    <Box
      flexDirection="column"
      {...(width ? { width, flexShrink: 0 } : { flexGrow: 1 })}
      paddingX={1}
      paddingY={1}
      borderStyle="single"
      borderColor={focused ? theme.accent : theme.border}
    >
      <Text color={theme.accent} bold>
        {title}
      </Text>
      <Box height={1} />
      {!threads ? (
        <Text color={theme.dim}>(loading)</Text>
      ) : threads.threads.length === 0 ? (
        <Text color={theme.dim}>(no threads)</Text>
      ) : (
        threads.threads.map((t, i) => {
          const selected = focused && i === cursor;
          const isOpen = openThreadId === t.threadId;
          const from = senderName(t.latestMessage.from);
          const account =
            "accountId" in t && t.accountId
              ? `[${t.accountId}${t.emailAddress ? ` ${t.emailAddress}` : ""}] `
              : "";
          const subject = `${account}${t.latestMessage.subject || "(no subject)"}`;
          const dateStr = relativeDate(t.latestMessage.date);
          const indicator = t.messageCount > 1 ? `(${t.messageCount})` : "";
          // Row leader: `❯` for the focused-cursor row, `▎` for the row
          // whose thread is currently loaded in the detail pane (regardless
          // of focus), or a space otherwise. Selected wins on the same row.
          const leader = selected ? "❯" : isOpen ? "▎" : " ";
          const raw = `${leader} ${dateStr.padEnd(8)} ${fitToWidth(from, 22)} ${subject} ${indicator}`;
          const ROW_TARGET = 120;
          const padded = raw.padEnd(ROW_TARGET);
          // Colour hierarchy:
          //   selected (focused cursor)   → selectedFg on selectedBg
          //   open thread (no focus)      → accent fg, no background
          //   default                     → theme.fg
          const color = selected ? theme.selectedFg : isOpen ? theme.accent : theme.fg;
          const bg = selected ? theme.selectedBg : undefined;
          return (
            <Text
              key={t.threadId}
              color={color}
              backgroundColor={bg}
              bold={isOpen && !selected}
              wrap="truncate"
            >
              {padded}
            </Text>
          );
        })
      )}
    </Box>
  );
}

// Strip the `<addr>` half of an RFC-5322 `Name <addr>` form so the thread
// row leads with the human-readable name. Falls back to the raw address
// when no name is present (still useful for noreply-style senders).
function senderName(raw: string): string {
  const m = raw.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  return m ? m[1].trim() : raw.trim();
}

function relativeDate(raw: string): string {
  // Gmail returns RFC 5322 dates. Best-effort format: "Mon 13" or "13:45".
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const sameYear = d.getFullYear() === now.getFullYear();
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
  if (sameYear) return `${months[d.getMonth()]} ${d.getDate().toString().padStart(2, " ")}`;
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d.getDate().toString().padStart(2, "0")}`;
}

export const ThreadList = memo(ThreadListImpl);
