import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetForTests as resetSession,
  setAuthorizedScopes,
  setSession,
} from "../../src/core/session.js";
import { buildMcpServer } from "../../src/server/build.js";

beforeEach(() => {
  resetSession();
  const oauth2Client = new OAuth2Client();
  setSession({ oauth2Client, gmail: google.gmail({ version: "v1", auth: oauth2Client }) });
});

describe("dispatcher scope gate", () => {
  it("rejects send_draft on a gmail.modify-only grant and names the permission it needs", async () => {
    setAuthorizedScopes(["gmail.modify", "gmail.settings.basic"]);
    const { dispatch } = buildMcpServer();
    const result = await dispatch("send_draft", { draftId: "d1" });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("gmail.compose");
    expect(text).toContain("gmail.send");
  });
});
