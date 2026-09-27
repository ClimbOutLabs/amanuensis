import { Box } from "ink";
import { memo } from "react";
import type { Theme } from "../themes/index.js";
import { ModalRow, ModalScreen } from "./ModalScreen.js";

interface Props {
  prompt: string;
  theme: Theme;
}

function ConfirmModalImpl({ prompt, theme }: Props) {
  return (
    <ModalScreen
      theme={theme}
      title="Confirm"
      borderColor={theme.warning}
      borderStyle="double"
      footerHint="[y] yes   [n / Esc] no"
    >
      <Box height={1} />
      <ModalRow theme={theme} color={theme.warning}>
        {prompt}
      </ModalRow>
    </ModalScreen>
  );
}

export const ConfirmModal = memo(ConfirmModalImpl);
