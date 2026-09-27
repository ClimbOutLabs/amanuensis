import { Box, Text } from "ink";
import { memo } from "react";
import type { Theme } from "../themes/index.js";

interface Props {
  mode: "add" | "remove";
  text: string;
  theme: Theme;
}

// Bottom-bar overlay mirroring CommandPalette / SearchBar: a single status-bar
// row at the foot of the screen. The user types a label name; Enter applies
// (add → get_or_create_label + modify_email; remove → modify_email),
// Esc cancels. Uses the same opaque `<Box backgroundColor>` pattern as the
// other bottom bars — no bleed risk because it's at the screen edge with
// no centered card beneath.

function LabelOverlayImpl({ mode, text, theme }: Props) {
  const prompt = mode === "add" ? "label+ " : "label- ";
  return (
    <Box paddingX={1} backgroundColor={theme.statusBarBg}>
      <Text color={theme.accent} bold>
        {prompt}
      </Text>
      <Text color={theme.statusBarFg}>{text}</Text>
      <Text color={theme.accent}>{"_"}</Text>
    </Box>
  );
}

export const LabelOverlay = memo(LabelOverlayImpl);
