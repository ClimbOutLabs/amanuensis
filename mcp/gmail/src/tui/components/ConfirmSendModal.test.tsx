// Pins the send-confirmation preview: the modal must surface the parsed
// recipients + subject so the user can catch a wrong/malformed To before the
// message leaves, and must show the "keep as draft" escape hatch.

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { defaultTheme } from "../themes/default.js";
import { ConfirmSendModal } from "./ConfirmSendModal.js";

describe("ConfirmSendModal", () => {
  it("shows recipients and subject in the preview", () => {
    const { lastFrame } = render(
      <ConfirmSendModal
        to={["Vahid Habibi <vahid@example.test>", "a@b.test"]}
        cc={["c@d.test"]}
        bcc={[]}
        subject="Re: Disclaimer for Ads"
        sendKind="reply"
        theme={defaultTheme}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Vahid Habibi <vahid@example.test>");
    expect(frame).toContain("a@b.test");
    expect(frame).toContain("Cc:");
    expect(frame).toContain("c@d.test");
    expect(frame).toContain("Re: Disclaimer for Ads");
    expect(frame).toContain("Send reply?");
    expect(frame).toContain("keep as draft");
  });

  it("omits empty Cc/Bcc rows and titles a fresh compose", () => {
    const { lastFrame } = render(
      <ConfirmSendModal
        to={["a@b.test"]}
        cc={[]}
        bcc={[]}
        subject=""
        sendKind="compose"
        theme={defaultTheme}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Send email?");
    expect(frame).toContain("(no subject)");
    expect(frame).not.toContain("Cc:");
    expect(frame).not.toContain("Bcc:");
  });
});
