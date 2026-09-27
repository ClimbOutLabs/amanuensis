import { Box, Text } from "ink";
import { memo } from "react";
import type { Theme } from "../themes/index.js";

interface Props {
  text: string;
  theme: Theme;
}

function CommandPaletteImpl({ text, theme }: Props) {
  return (
    <Box paddingX={1} backgroundColor={theme.statusBarBg}>
      <Text color={theme.accent} bold>
        {":"}
      </Text>
      <Text color={theme.statusBarFg}>{text}</Text>
      <Text color={theme.accent}>{"_"}</Text>
    </Box>
  );
}

export const CommandPalette = memo(CommandPaletteImpl);
