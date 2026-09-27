import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getConfigDir, getCredentialsPath, getDraftsDir, getOAuthPath } from "./config-paths.js";

describe("getConfigDir", () => {
  it("defaults to ~/.gmail-mcp", () => {
    expect(getConfigDir({})).toBe(path.join(os.homedir(), ".gmail-mcp"));
  });

  it("honors GMAIL_CONFIG_DIR override", () => {
    expect(getConfigDir({ GMAIL_CONFIG_DIR: "/var/lib/gmail" })).toBe("/var/lib/gmail");
  });

  it("ignores empty/whitespace GMAIL_CONFIG_DIR", () => {
    expect(getConfigDir({ GMAIL_CONFIG_DIR: "" })).toBe(path.join(os.homedir(), ".gmail-mcp"));
    expect(getConfigDir({ GMAIL_CONFIG_DIR: "   " })).toBe(path.join(os.homedir(), ".gmail-mcp"));
  });
});

describe("getOAuthPath", () => {
  it("defaults to <configDir>/gcp-oauth.keys.json", () => {
    expect(getOAuthPath({})).toBe(path.join(os.homedir(), ".gmail-mcp", "gcp-oauth.keys.json"));
  });

  it("honors GMAIL_OAUTH_PATH (overrides config dir)", () => {
    expect(getOAuthPath({ GMAIL_CONFIG_DIR: "/x", GMAIL_OAUTH_PATH: "/explicit/keys.json" })).toBe(
      "/explicit/keys.json",
    );
  });

  it("composes with GMAIL_CONFIG_DIR when GMAIL_OAUTH_PATH unset", () => {
    expect(getOAuthPath({ GMAIL_CONFIG_DIR: "/x" })).toBe("/x/gcp-oauth.keys.json");
  });
});

describe("getCredentialsPath", () => {
  it("defaults to <configDir>/credentials.json", () => {
    expect(getCredentialsPath({})).toBe(path.join(os.homedir(), ".gmail-mcp", "credentials.json"));
  });

  it("honors GMAIL_CREDENTIALS_PATH", () => {
    expect(
      getCredentialsPath({ GMAIL_CONFIG_DIR: "/x", GMAIL_CREDENTIALS_PATH: "/y/creds.json" }),
    ).toBe("/y/creds.json");
  });

  it("composes with GMAIL_CONFIG_DIR when GMAIL_CREDENTIALS_PATH unset", () => {
    expect(getCredentialsPath({ GMAIL_CONFIG_DIR: "/x" })).toBe("/x/credentials.json");
  });
});

describe("getDraftsDir", () => {
  it("defaults to <configDir>/drafts", () => {
    expect(getDraftsDir({})).toBe(path.join(os.homedir(), ".gmail-mcp", "drafts"));
  });

  it("composes with GMAIL_CONFIG_DIR", () => {
    expect(getDraftsDir({ GMAIL_CONFIG_DIR: "/x" })).toBe("/x/drafts");
  });
});
