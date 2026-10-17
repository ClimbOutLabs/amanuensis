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

describe("health_check scope notice", () => {
  beforeEach(() => _resetForTests());

  it("has no notice by default", async () => {
    expect(await healthText()).not.toContain("Notice:");
  });

  it("repeats the reconnect notice owners see at startup", async () => {
    setSession({
      oauth2Client: new OAuth2Client(),
      gmail: google.gmail({ version: "v1" }),
      scopeNotice: "This Gmail connection can send email as you.",
    });
    expect(await healthText()).toContain("Notice: This Gmail connection can send email as you.");
  });
});
