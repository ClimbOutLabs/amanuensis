import { Box } from "ink";
import { memo } from "react";
import type { Theme } from "../themes/index.js";
import { ModalRow, ModalScreen } from "./ModalScreen.js";

interface Props {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** "compose" (fresh) vs "reply" — only changes the title verb. */
  sendKind: "compose" | "reply";
  theme: Theme;
}

// Confirmation gate shown after the editor exits, before a compose/reply
// message is actually sent. Surfaces the parsed recipients + subject so the
// user can catch a malformed To (the display-name recipient bug that used to
// fail the send) or a wrong address before it leaves. `y` sends; `n`/Esc keeps
// the message as an on-disk draft.
function ConfirmSendModalImpl({ to, cc, bcc, subject, sendKind, theme }: Props) {
  const title = sendKind === "reply" ? "Send reply?" : "Send email?";
  return (
    <ModalScreen
      theme={theme}
      title={title}
      borderColor={theme.warning}
      borderStyle="double"
      footerHint="[y] send   [n / Esc] keep as draft"
    >
      <Box height={1} />
      <ModalRow theme={theme} color={theme.accent} bold>
        {`To:      ${to.join(", ") || "(none)"}`}
      </ModalRow>
      {cc.length > 0 ? <ModalRow theme={theme}>{`Cc:      ${cc.join(", ")}`}</ModalRow> : null}
      {bcc.length > 0 ? <ModalRow theme={theme}>{`Bcc:     ${bcc.join(", ")}`}</ModalRow> : null}
      <ModalRow theme={theme}>{`Subject: ${subject || "(no subject)"}`}</ModalRow>
    </ModalScreen>
  );
}

export const ConfirmSendModal = memo(ConfirmSendModalImpl);
