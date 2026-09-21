import { Box, Text } from "ink";
import { memo } from "react";
import { defaultBindings } from "../keymap.js";
import type { Theme } from "../themes/index.js";

interface Props {
  focus: string;
  theme: Theme;
}

// Context-sensitive footer. The drill ladder mirrors the keymap registry —
// each focus exposes the bindings most useful at that depth.
function HelpBarImpl({ focus, theme }: Props) {
  const hints =
    focus === "view"
      ? "[j/k] scroll  [↑/↓] msg  [[/]] thread  [h] back  [r] reply  [d] dl  [?] help"
      : focus === "message"
        ? "[j/k] msg  [↑/↓] msg  [[/]] thread  [l] read  [h] back  [r] reply  [?] help"
        : focus === "threads"
          ? "[j/k] thread  [l/Enter] open  [[/]] adjacent  [/] search  [:] cmd  [?] help"
          : "[j/k] label  [l/Enter] select  [Tab] focus next  [ga] account  [?] help";
  void defaultBindings;
  return (
    <Box paddingX={1}>
      <Text color={theme.helpBarFg}>{hints}</Text>
    </Box>
  );
}

export const HelpBar = memo(HelpBarImpl);
