import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { beforeEach, describe, expect, it } from "vitest";
import "../../src/core/ops/health.js";
import type { OperationContext } from "../../src/core/context.js";
import { registry } from "../../src/core/registry.js";
import { _resetForTests, setSession } from "../../src/core/session.js";

function ctx(): OperationContext {
  return {
    gmail: google.gmail({ version: "v1" }),
    oauth2Client: new OAuth2Client(),
    authorizedScopes: [],
    toolName: "health_check",
    accountId: null,
  };
}

async function healthText(): Promise<string> {
  const res = await registry.dispatch("health_check", {}, ctx());
  return res.content.map((c) => c.text).join("\n");
}

function activate({ scopes, accountId }: { scopes: string[]; accountId: string }): void {
  setSession({
    oauth2Client: new OAuth2Client(),
    gmail: google.gmail({ version: "v1" }),
    authorizedScopes: scopes,
    accountId,
  });
}

describe("health_check scope notice", () => {
  beforeEach(() => _resetForTests());

  it("has no notice for a read-only connection", async () => {
    activate({ scopes: ["gmail.readonly"], accountId: "personal" });
    expect(await healthText()).not.toContain("Notice:");
  });

  it("names the active account's send-capable scope and reconnect command", async () => {
    activate({ scopes: ["gmail.modify"], accountId: "work" });
    const text = await healthText();
    expect(text).toContain("Notice:");
    expect(text).toContain("gmail account auth work --scopes=gmail.readonly");
  });

  it("follows the active account when the session switches, in both directions", async () => {
    activate({ scopes: ["gmail.modify"], accountId: "work" });
    activate({ scopes: ["gmail.readonly"], accountId: "personal" });
    expect(await healthText()).not.toContain("Notice:");

    activate({ scopes: ["gmail.full"], accountId: "archive" });
    const text = await healthText();
    expect(text).toContain("gmail.full");
    expect(text).toContain("gmail account auth archive");
    expect(text).not.toContain("work");
  });
});
