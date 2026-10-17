import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveCredentialsToFile } from "../../src/core/auth-flow.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-perm-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("saveCredentialsToFile", () => {
  it("tightens an existing world-readable credentials file to 0600", () => {
    const file = path.join(dir, "credentials.json");
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    saveCredentialsToFile({ path: file, tokens: { refresh_token: "r" }, scopes: ["gmail.readonly"] });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
