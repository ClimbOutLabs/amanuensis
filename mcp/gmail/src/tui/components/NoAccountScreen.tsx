import { Box, Text, useApp, useInput } from "ink";
import { memo } from "react";
import type { Theme } from "../themes/index.js";

interface Props {
  theme: Theme;
  /** Optional contextual reason — appears as a dim subtitle. Typically the
      bootstrap error message ("credentials.json not found at ...") or
      "no accounts in accounts.json". */
  reason?: string;
  /** Called when the user presses `a` (or Enter). Implementation should
      suspend Ink, run the interactive `gmail account auth` flow, and
      then resolve to either { authed: true } so the TUI can re-bootstrap
      or { authed: false } if the user aborted. */
  onAuth: () => void;
}

// Empty-state screen shown when `gmail tui` boots without any configured
// account. The TUI is unusable in this state — no Gmail client, no
// inbox, no labels — so instead of crashing on the bootstrap error we
// render this fullscreen panel that explains the situation and offers
// the user a one-key launch into `gmail account auth`.
//
// Design intent: looks like an Ink-native dialog (border + accent
// header), not a stack trace. The "[a]" hotkey echoes the keymap
// language used throughout the rest of the TUI.
function NoAccountScreenImpl({ theme, reason, onAuth }: Props) {
  const { exit } = useApp();
  useInput((input) => {
    if (input === "a" || input === "A") {
      onAuth();
    } else if (input === "q" || input === "Q") {
      exit();
    }
  });
  return (
    <Box
      flexDirection="column"
      width="100%"
      height="100%"
      alignItems="center"
      justifyContent="center"
    >
      <Box
        flexDirection="column"
        width={66}
        borderStyle="single"
        borderColor={theme.accent}
        paddingX={2}
        paddingY={1}
      >
        <Text color={theme.accent} bold backgroundColor={theme.bg}>
          No Gmail account configured
        </Text>
        <Box height={1} />
        <Text color={theme.fg} backgroundColor={theme.bg} wrap="wrap">
          The TUI needs a Gmail account to show you mail. Authorise one before it can do anything
          useful.
        </Text>
        {reason ? (
          <>
            <Box height={1} />
            <Text color={theme.dim} backgroundColor={theme.bg} wrap="wrap">
              {reason}
            </Text>
          </>
        ) : null}
        <Box height={1} />
        <Text color={theme.fg} backgroundColor={theme.bg}>
          {"  "}
          <Text color={theme.accent} bold>
            [a]
          </Text>
          {" launch `gmail account auth` (interactive)"}
        </Text>
        <Text color={theme.fg} backgroundColor={theme.bg}>
          {"  "}
          <Text color={theme.accent} bold>
            [q]
          </Text>
          {" quit and authorise from the shell"}
        </Text>
        <Box height={1} />
        <Text color={theme.dim} backgroundColor={theme.bg}>
          Or run from another terminal: gmail account auth &lt;id&gt;
        </Text>
      </Box>
    </Box>
  );
}

export const NoAccountScreen = memo(NoAccountScreenImpl);
