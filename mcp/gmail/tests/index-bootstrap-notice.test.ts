import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@george43g/robustness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@george43g/robustness")>()),
  warn,
}));

import { _resetForTests as resetSession } from "../src/core/session.js";
import { _resetDispatcherForTests, bootstrapSession } from "../src/index.js";

let tmpDir: string;
let originalEnv: typeof process.env;

function writeConnection(scopes: string[]): void {
  fs.writeFileSync(
    path.join(tmpDir, "gcp-oauth.keys.json"),
    JSON.stringify({ installed: { client_id: "test-id", client_secret: "test-secret" } }),
  );
  fs.writeFileSync(
    path.join(tmpDir, "credentials.json"),
    JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" }, scopes }),
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-bootstrap-notice-"));
  originalEnv = { ...process.env };
  for (const k of [
    "GMAIL_ACCOUNT",
    "GMAIL_CREDENTIALS_JSON",
    "GMAIL_CREDENTIALS_OP",
    "GMAIL_CREDENTIALS_PATH",
    "GMAIL_OAUTH_KEYS_JSON",
    "GMAIL_OAUTH_PATH",
  ]) {
    delete process.env[k];
  }
  process.env.GMAIL_CONFIG_DIR = tmpDir;
  warn.mockClear();
  resetSession();
  _resetDispatcherForTests();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.env = originalEnv;
  resetSession();
  _resetDispatcherForTests();
});

describe("bootstrapSession scope notice", () => {
  it("logs the send-capable notice for gmail.modify credentials", async () => {
    writeConnection(["gmail.modify"]);
    await bootstrapSession();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("can send email as you"));
  });

  it("logs nothing for read-only credentials", async () => {
    writeConnection(["gmail.readonly"]);
    await bootstrapSession();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("can send email as you"));
  });
});
