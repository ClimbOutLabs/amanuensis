import { Box, Text } from "ink";
import { memo } from "react";
import type { LabelList } from "../reducer.js";
import type { Theme } from "../themes/index.js";

interface Props {
  labels: LabelList | null;
  cursor: number;
  focused: boolean;
  selectedLabelId: string;
  theme: Theme;
  /** Outer width including border + padding. Driven by the responsive
      layout helper in App.tsx so all four panes share a single source of
      truth and the layout doesn't drift between renders. */
  width?: number;
}

function SidebarImpl({ labels, cursor, focused, selectedLabelId, theme, width = 24 }: Props) {
  const items = labels ? [...labels.system, ...labels.user] : [];
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
      <Text color={theme.accent} bold>
        Labels
      </Text>
      <Box height={1} />
      {labels === null ? (
        <Text color={theme.dim}>(loading)</Text>
      ) : items.length === 0 ? (
        // Empty-but-defined labels means cross-account scope is active —
        // labels are per-account, so there's no unified list to show.
        <Text color={theme.dim}>(no labels — pick one account)</Text>
      ) : (
        items.map((label, i) => {
          const selected = focused && i === cursor;
          const active = label.id === selectedLabelId;
          const prefix = active ? "*" : " ";
          return (
            <Text
              key={label.id}
              color={selected ? theme.selectedFg : theme.fg}
              backgroundColor={selected ? theme.selectedBg : undefined}
              bold={active}
            >
              {`${prefix} ${displayName(label.name)}`}
            </Text>
          );
        })
      )}
    </Box>
  );
}

function displayName(raw: string): string {
  // Gmail returns "CATEGORY_PERSONAL" etc. — humanise.
  if (raw.startsWith("CATEGORY_")) return raw.slice(9).toLowerCase();
  if (raw === "INBOX") return "Inbox";
  if (raw === "SENT") return "Sent";
  if (raw === "DRAFT") return "Drafts";
  if (raw === "STARRED") return "Starred";
  if (raw === "TRASH") return "Trash";
  if (raw === "SPAM") return "Spam";
  return raw;
}

export const Sidebar = memo(SidebarImpl);
