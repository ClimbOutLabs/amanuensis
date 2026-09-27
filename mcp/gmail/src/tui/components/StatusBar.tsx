import { Box, Text } from "ink";
import { memo } from "react";
import type { Theme } from "../themes/index.js";

interface Props {
  mode: string;
  status: string;
  account: string | null;
  theme: Theme;
}

function StatusBarImpl({ mode, status, account, theme }: Props) {
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      paddingX={1}
      backgroundColor={theme.statusBarBg}
    >
      <Box>
        <Text color={theme.accent} bold>
          {`-- ${mode.toUpperCase()} --`}
        </Text>
        <Text color={theme.statusBarFg}>{`  ${status}`}</Text>
      </Box>
      <Text color={theme.statusBarFg}>{account ? `[${account}]` : "[no account]"}</Text>
    </Box>
  );
}

export const StatusBar = memo(StatusBarImpl);
