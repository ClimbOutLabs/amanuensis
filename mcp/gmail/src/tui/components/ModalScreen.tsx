import { Box, Text } from "ink";
import { memo, type ReactNode } from "react";
import type { Theme } from "../themes/index.js";

// `<ModalScreen>` is the takeover-pattern primitive for every centered modal
// in the TUI. It replaces the 3-pane main view while open and paints an
// opaque, bordered frame that fills the available vertical space and the
// full terminal width.
//
// Why: Ink 7's `<Box>` silently ignores `backgroundColor` — only `<Text>`
// honours it. A bordered `<Box>` therefore draws its border but leaves the
// interior cells unwritten, so the diff renderer keeps showing whatever was
// previously there (e.g. the email body in the message pane). The fix is to
// (a) take over the screen so nothing else paints in the same rows, and (b)
// emit every modal row through `<ModalRow>` (or a manually-padded `<Text
// backgroundColor>`) so every cell on every row is written explicitly.
//
// Default `width="100%"`: the bordered card spans the terminal so there are
// no untouched columns to the left/right. Callers can override `width` for a
// narrower sesh-style popup, but they then accept that side cells are left
// to whatever previous frame painted (rare in practice because the takeover
// row range is fully covered top-to-bottom).

interface ModalScreenProps {
  theme: Theme;
  title?: string;
  /** Border colour override. Defaults to `theme.accent`. */
  borderColor?: string;
  /** Border style. Defaults to "single"; confirm dialogs use "double". */
  borderStyle?: "single" | "double" | "round";
  /** Footer hint line rendered dim at the bottom (e.g. "press ? to close"). */
  footerHint?: string;
  children: ReactNode;
}

function ModalScreenImpl({
  theme,
  title,
  borderColor,
  borderStyle = "single",
  footerHint,
  children,
}: ModalScreenProps) {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle={borderStyle}
      borderColor={borderColor ?? theme.accent}
    >
      {title ? (
        <Box paddingX={1}>
          <Text color={theme.accent} backgroundColor={theme.modalBg} bold>
            {title}
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {children}
      </Box>
      {footerHint ? (
        <Box paddingX={1}>
          <Text color={theme.dim} backgroundColor={theme.modalBg}>
            {footerHint}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export const ModalScreen = memo(ModalScreenImpl);

// `<ModalRow>` is the single row primitive inside `<ModalScreen>`. The point
// is the unconditional `backgroundColor` — every row gets every cell written
// with a background fill so no underlying frame content leaks through.
//
// `children` is intentionally `ReactNode`: callers pass either a plain
// string (most rows) or nested `<Text>` chunks for partial highlighting
// (e.g. fuzzysort match highlighting in `<HelpModal>`).

interface ModalRowProps {
  theme: Theme;
  color?: string;
  bold?: boolean;
  /** Override the default modalBg (rare — used by selection-highlighted rows). */
  backgroundColor?: string;
  children: ReactNode;
}

function ModalRowImpl({ theme, color, bold, backgroundColor, children }: ModalRowProps) {
  return (
    <Text color={color ?? theme.fg} backgroundColor={backgroundColor ?? theme.modalBg} bold={bold}>
      {children}
    </Text>
  );
}

export const ModalRow = memo(ModalRowImpl);
