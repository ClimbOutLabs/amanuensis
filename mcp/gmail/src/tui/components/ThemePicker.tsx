import { Box } from "ink";
import { memo } from "react";
import { listThemeNames, type Theme, themes } from "../themes/index.js";
import { ModalRow, ModalScreen } from "./ModalScreen.js";

interface Props {
  cursor: number;
  current: string;
  theme: Theme;
}

function ThemePickerImpl({ cursor, current, theme }: Props) {
  const names = listThemeNames();
  return (
    <ModalScreen
      theme={theme}
      title="Theme"
      footerHint="[j/k] navigate  [Enter] apply  [Esc] close"
    >
      <Box height={1} />
      {names.map((name, i) => {
        const selected = i === cursor;
        const active = name === current;
        const meta = themes[name];
        const note = meta?.nerd ? "  (requires Nerd Font)" : "";
        return (
          <ModalRow
            key={name}
            theme={theme}
            color={selected ? theme.selectedFg : theme.fg}
            backgroundColor={selected ? theme.selectedBg : theme.modalBg}
            bold={active}
          >
            {`${active ? "*" : " "} ${name}${note}`}
          </ModalRow>
        );
      })}
    </ModalScreen>
  );
}

export const ThemePicker = memo(ThemePickerImpl);
