import { Box } from "ink";
import { memo } from "react";
import type { AccountList } from "../hooks/useGmail.js";
import type { Theme } from "../themes/index.js";
import { ModalRow, ModalScreen } from "./ModalScreen.js";

interface Props {
  list: AccountList | null;
  cursor: number;
  // Reserved for a future multi-account UI revival. Single-account mode
  // ignores this; the prop stays so the overlay payload shape is stable.
  selectedIds?: string[];
  theme: Theme;
}

function AccountSwitcherImpl({ list, cursor, theme }: Props) {
  return (
    <ModalScreen
      theme={theme}
      title="Accounts"
      footerHint="[j/k] navigate  [Enter] switch  [Esc] close"
    >
      <Box height={1} />
      {!list ? (
        <ModalRow theme={theme} color={theme.dim}>
          (loading)
        </ModalRow>
      ) : list.accounts.length === 0 ? (
        <ModalRow theme={theme} color={theme.warning}>
          {"No accounts. Run `gmail account auth <id>`."}
        </ModalRow>
      ) : (
        list.accounts.map((a, i) => {
          const selected = i === cursor;
          const marker = a.isActive ? "*" : a.isDefault ? "d" : " ";
          const email = a.emailAddress ? `  ${a.emailAddress}` : "";
          return (
            <ModalRow
              key={a.id}
              theme={theme}
              color={selected ? theme.selectedFg : theme.fg}
              backgroundColor={selected ? theme.selectedBg : theme.modalBg}
            >
              {`${marker} ${a.id}${email}`}
            </ModalRow>
          );
        })
      )}
    </ModalScreen>
  );
}

export const AccountSwitcher = memo(AccountSwitcherImpl);
