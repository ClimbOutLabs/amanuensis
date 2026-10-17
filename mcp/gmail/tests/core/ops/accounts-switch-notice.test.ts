import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, getAccountCredentialsPath, getAccountDir } from "../../../src/core/accounts.js";
import "../../../src/core/ops/accounts.js";
import { registry } from "../../../src/core/registry.js";
import { _resetForTests, setSession } from "../../../src/core/session.js";

let tmpDir: string;
let originalConfigDir: string | undefined;

function ctx() {
  return {
    gmail: google.gmail({ version: "v1" }),
    oauth2Client: new OAuth2Client(),
    authorizedScopes: ["gmail.readonly"],
    toolName: "switch_account",
    accountId: null,
  };
}

function writeAccount({ id, scopes }: { id: string; scopes: string[] }): void {
  addAccount(id, { emailAddress: `${id}@example.com`, scopes });
  fs.mkdirSync(getAccountDir(id), { recursive: true });
  fs.writeFileSync(
    getAccountCredentialsPath(id),
    JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" }, scopes }),
  );
}

async function switchTo(accountId: string): Promise<string> {
  const res = await registry.dispatch("switch_account", { accountId }, ctx());
  return res.content.map((c) => c.text).join("\n");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-switch-notice-"));
  originalConfigDir = process.env.GMAIL_CONFIG_DIR;
  process.env.GMAIL_CONFIG_DIR = tmpDir;
  fs.writeFileSync(
    path.join(tmpDir, "gcp-oauth.keys.json"),
    JSON.stringify({ installed: { client_id: "cid", client_secret: "csec" } }),
  );
  _resetForTests();
  writeAccount({ id: "wide", scopes: ["gmail.modify"] });
  writeAccount({ id: "narrow", scopes: ["gmail.readonly"] });
  setSession({
    oauth2Client: new OAuth2Client(),
    gmail: google.gmail({ version: "v1" }),
    authorizedScopes: ["gmail.readonly"],
    accountId: "narrow",
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.GMAIL_CONFIG_DIR;
  else process.env.GMAIL_CONFIG_DIR = originalConfigDir;
  _resetForTests();
});

describe("switch_account scope notice", () => {
  it("warns when switching from a read-only account to a gmail.modify one", async () => {
    const text = await switchTo("wide");
    expect(text).toContain("Notice:");
    expect(text).toContain("gmail account auth wide --scopes=gmail.readonly");
  });

  it("does not carry the old account's notice to a read-only account", async () => {
    await switchTo("wide");
    const text = await switchTo("narrow");
    expect(text).not.toContain("Notice:");
  });
});
