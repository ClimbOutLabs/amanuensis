import { Box, Text } from "ink";
import { memo } from "react";
import type { ThreadView } from "../reducer.js";
import type { Theme } from "../themes/index.js";
import { senderDisplayName } from "../util/sender-color.js";

interface Props {
  thread: ThreadView | null;
  cursor: number;
  theme: Theme;
  /** Inner width (excludes border/padding of the parent pane). Used as the
      truncate budget for the joined pill text. */
  width: number;
}

// Horizontal pill row rendered above MessageDetailPane when a thread has
// more than one message. Each pill shows the sender's display name and a
// compact date; the active message gets bold + inverse highlighting.
//
// Why a pill row instead of the legacy vertical MessageListPane:
//   - Threads typically have 1–5 messages but the old pane reserved the
//     full screen height for that list, wasting vertical space.
//   - A single row above the detail pane uses ~3% of the height (with
//     padding) and frees a full column horizontally for the email body.
//
// Returns null for single-message threads — no information to convey.
function MessagePillRowImpl({ thread, cursor, theme, width }: Props) {
  if (!thread || thread.messages.length <= 1) return null;
  const messages = thread.messages;
  const clampedCursor = Math.min(Math.max(0, cursor), messages.length - 1);
  // Box wrapper is load-bearing: a bare <Text> child inside a column-flex
  // parent gets a 0-height layout under Ink 7's yoga reconciler, which
  // hides the pill row entirely. Wrapping in a Box with explicit
  // flexShrink=0 + paddingX pins the row at one visible line.
  return (
    <Box width={width} flexShrink={0} paddingX={1}>
      <Text wrap="truncate" backgroundColor={theme.bg}>
        {messages.map((msg, i) => {
          const selected = i === clampedCursor;
          const name = senderDisplayName(msg.from);
          const date = formatDate(msg.date);
          const attach = msg.attachments.length > 0 ? " 📎" : "";
          const label = `${name} · ${date}${attach}`;
          // Joiner between pills — dim vertical bar matches the body-quote
          // marker visually. First pill has no leading joiner.
          const joiner = i > 0 ? " │ " : "";
          return (
            <Text
              key={msg.messageId}
              color={selected ? theme.selectedFg : theme.fg}
              backgroundColor={selected ? theme.selectedBg : theme.bg}
              bold={selected}
            >
              {joiner}
              {label}
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}

function formatDate(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
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
  return `${months[d.getMonth()]} ${d.getDate().toString().padStart(2, " ")}`;
}

export const MessagePillRow = memo(MessagePillRowImpl);
