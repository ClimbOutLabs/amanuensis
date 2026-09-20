import { Box } from "ink";
import { memo } from "react";
import type { LocalDraft } from "../drafts-recovery.js";
import type { Theme } from "../themes/index.js";
import { ModalRow, ModalScreen } from "./ModalScreen.js";

interface Props {
  drafts: LocalDraft[];
  cursor: number;
  theme: Theme;
}

/** Recovery picker for locally-persisted `.eml` compose drafts. Rows show the
    compose kind, subject, recipients, and a body snippet so the user can pick
    which aborted/crashed compose to resume. */
function DraftsRecoveryImpl({ drafts, cursor, theme }: Props) {
  return (
    <ModalScreen
      theme={theme}
      title="Recover drafts"
      footerHint="[j/k] navigate  [Enter] resume  [d] discard  [Esc] close"
    >
      <Box height={1} />
      {drafts.length === 0 ? (
        <ModalRow theme={theme} color={theme.dim}>
          No local drafts to recover.
        </ModalRow>
      ) : (
        drafts.map((d, i) => {
          const selected = i === cursor;
          const subject = d.subject || "(no subject)";
          const to = d.to.length ? ` → ${d.to.join(", ")}` : "";
          const snippet = d.snippet ? `  ${d.snippet}` : "";
          return (
            <ModalRow
              key={d.path}
              theme={theme}
              color={selected ? theme.selectedFg : theme.fg}
              backgroundColor={selected ? theme.selectedBg : theme.modalBg}
            >
              {`[${d.kind}] ${subject}${to}${snippet}`}
            </ModalRow>
          );
        })
      )}
    </ModalScreen>
  );
}

export const DraftsRecovery = memo(DraftsRecoveryImpl);
