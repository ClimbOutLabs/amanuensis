import { fitToWidth, truncateToWidth } from "@george43g/tui-kit";
import { Box, Text } from "ink";
import { memo } from "react";
import type { ThreadView } from "../reducer.js";
import type { Theme } from "../themes/index.js";
import { senderColor, senderDisplayName } from "../util/sender-color.js";

interface Props {
  thread: ThreadView | null;
  cursor: number;
  focused: boolean;
  theme: Theme;
  /** Outer pane width (border + padding included). Defaults to the legacy
      fixed 56 cols so the component still renders standalone. */
  width?: number;
}

// Compact list of messages in the open thread — the middle pane in the
// drill-down (Sidebar → Threads → MessageList → MessageView). Each row
// shows: senderTag · date · attachments · snippet. Senders get
// deterministic palette colours so a multi-person thread is easy to scan.
//
// Position indicator lives in the header row ("3 of 7") — yazi-style — so
// the user always knows where they are within the thread.

function MessageListPaneImpl({ thread, cursor, focused, theme, width = 56 }: Props) {
  if (!thread) {
    return (
      <Box
        flexDirection="column"
        width={width}
        flexShrink={0}
        paddingX={1}
        paddingY={1}
        borderStyle="single"
        borderColor={focused ? theme.accent : theme.border}
      >
        <Text color={theme.dim}>(no thread open)</Text>
      </Box>
    );
  }
  const messages = thread.messages;
  const subject = messages[0]?.subject || "(no subject)";
  const clampedCursor = Math.min(Math.max(0, cursor), Math.max(0, messages.length - 1));
  return (
    // Fixed width on the compact list keeps the right-pane (MessageDetail)
    // boundary stable as the message cursor moves through threads with
    // wildly different snippet lengths. Without this, the flex layout
    // shrinks MessageDetail enough to clip its header rows.
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      paddingX={1}
      paddingY={1}
      borderStyle="single"
      borderColor={focused ? theme.accent : theme.border}
    >
      <Text color={theme.accent} bold>
        {truncateToWidth(subject, 60)}
      </Text>
      <Text color={theme.dim}>
        {`${messages.length} message${messages.length === 1 ? "" : "s"} · ${clampedCursor + 1}/${messages.length}`}
      </Text>
      <Box height={1} />
      {messages.length === 0 ? (
        <Text color={theme.dim}>(empty thread)</Text>
      ) : (
        messages.map((msg, i) => {
          const selected = focused && i === clampedCursor;
          const color = selected ? theme.selectedFg : senderColor(theme, msg.from);
          const bg = selected ? theme.selectedBg : undefined;
          const cursorMark = selected ? "❯" : " ";
          const name = senderDisplayName(msg.from);
          const date = formatDate(msg.date);
          const attach = msg.attachments.length > 0 ? ` 📎${msg.attachments.length}` : "";
          const snippet = oneLine(msg.body).slice(0, 80);
          return (
            <Box key={msg.messageId} flexDirection="column">
              <Text color={color} backgroundColor={bg} bold={selected} wrap="truncate">
                {`${cursorMark} ${fitToWidth(name, 24)}  ${date.padEnd(16)}${attach}`}
              </Text>
              <Text
                color={selected ? theme.selectedFg : theme.dim}
                backgroundColor={bg}
                wrap="truncate"
              >
                {`    ${snippet}`}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

function oneLine(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

function formatDate(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 16);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
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
  return `${months[d.getMonth()]} ${d.getDate().toString().padStart(2, " ")}  ${hh}:${mm}`;
}

export const MessageListPane = memo(MessageListPaneImpl);
