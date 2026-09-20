// Tests for the env-driven OAuth keys path (Phase F).
//
// We don't exercise runOAuthFlow / saveCredentialsToFile here — those touch
// the network and disk. Focus is the loadOAuthKeys precedence + parser.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _testing,
  createOAuthClient,
  findAvailablePort,
  formatCredentialsForExport,
  loadOAuthKeys,
  saveCredentialsToFile,
} from "./auth-flow.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-auth-flow-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadOAuthKeys precedence", () => {
  it("env GMAIL_OAUTH_KEYS_JSON wins over disk", () => {
    const onDisk = path.join(tmpDir, "keys.json");
    fs.writeFileSync(
      onDisk,
      JSON.stringify({ installed: { client_id: "from-disk", client_secret: "disk-secret" } }),
    );
    const result = loadOAuthKeys({
      oauthPath: onDisk,
      env: {
        GMAIL_OAUTH_KEYS_JSON: JSON.stringify({
          installed: { client_id: "from-env", client_secret: "env-secret" },
        }),
      },
    });
    expect(result.client_id).toBe("from-env");
    expect(result.client_secret).toBe("env-secret");
  });

  it("ignores empty/whitespace GMAIL_OAUTH_KEYS_JSON and falls through to disk", () => {
    const onDisk = path.join(tmpDir, "keys.json");
    fs.writeFileSync(
      onDisk,
      JSON.stringify({ installed: { client_id: "disk", client_secret: "secret" } }),
    );
    const result = loadOAuthKeys({
      oauthPath: onDisk,
      env: { GMAIL_OAUTH_KEYS_JSON: "   " },
    });
    expect(result.client_id).toBe("disk");
  });

  it("loads from disk when env unset", () => {
    const onDisk = path.join(tmpDir, "keys.json");
    fs.writeFileSync(
      onDisk,
      JSON.stringify({ web: { client_id: "web-id", client_secret: "web-secret" } }),
    );
    const result = loadOAuthKeys({ oauthPath: onDisk, env: {} });
    expect(result.client_id).toBe("web-id");
    expect(result.client_secret).toBe("web-secret");
  });
});

describe("loadOAuthKeys env-JSON shapes", () => {
  it("accepts {installed:{...}} shape", () => {
    const result = loadOAuthKeys({
      oauthPath: "/nonexistent",
      env: {
        GMAIL_OAUTH_KEYS_JSON: JSON.stringify({
          installed: { client_id: "a", client_secret: "b" },
        }),
      },
    });
    expect(result).toEqual({ client_id: "a", client_secret: "b" });
  });

  it("accepts {web:{...}} shape", () => {
    const result = loadOAuthKeys({
      oauthPath: "/nonexistent",
      env: {
        GMAIL_OAUTH_KEYS_JSON: JSON.stringify({
          web: { client_id: "a", client_secret: "b" },
        }),
      },
    });
    expect(result).toEqual({ client_id: "a", client_secret: "b" });
  });

  it("accepts bare {client_id, client_secret} shape", () => {
    const result = loadOAuthKeys({
      oauthPath: "/nonexistent",
      env: {
        GMAIL_OAUTH_KEYS_JSON: JSON.stringify({ client_id: "a", client_secret: "b" }),
      },
    });
    expect(result).toEqual({ client_id: "a", client_secret: "b" });
  });

  it("rejects malformed JSON", () => {
    expect(() =>
      loadOAuthKeys({
        oauthPath: "/nonexistent",
        env: { GMAIL_OAUTH_KEYS_JSON: "{{{not-json" },
      }),
    ).toThrow(/Invalid GMAIL_OAUTH_KEYS_JSON/);
  });

  it("rejects JSON missing client_id/client_secret", () => {
    expect(() =>
      loadOAuthKeys({
        oauthPath: "/nonexistent",
        env: { GMAIL_OAUTH_KEYS_JSON: JSON.stringify({ installed: { client_id: "only-id" } }) },
      }),
    ).toThrow(/client_id and client_secret/);
  });

  it("rejects non-object JSON", () => {
    expect(() =>
      loadOAuthKeys({
        oauthPath: "/nonexistent",
        env: { GMAIL_OAUTH_KEYS_JSON: JSON.stringify("a string") },
      }),
    ).toThrow(/must be a JSON object/);
  });
});

describe("loadOAuthKeys disk path", () => {
  it("errors clearly when neither env nor disk has keys", () => {
    expect(() =>
      loadOAuthKeys({
        oauthPath: path.join(tmpDir, "missing.json"),
        env: {},
      }),
    ).toThrow(/OAuth keys not found.*GMAIL_OAUTH_KEYS_JSON/);
  });

  it("rejects malformed disk JSON", () => {
    const onDisk = path.join(tmpDir, "bad.json");
    fs.writeFileSync(onDisk, "not json");
    expect(() => loadOAuthKeys({ oauthPath: onDisk, env: {} })).toThrow(/Invalid OAuth keys file/);
  });

  it("rejects disk JSON missing required fields", () => {
    const onDisk = path.join(tmpDir, "incomplete.json");
    fs.writeFileSync(onDisk, JSON.stringify({ installed: { client_id: "only" } }));
    expect(() => loadOAuthKeys({ oauthPath: onDisk, env: {} })).toThrow(
      /client_id and client_secret/,
    );
  });

  it("copies gcp-oauth.keys.json from cwd to configDir if missing", () => {
    const cwd = path.join(tmpDir, "cwd");
    const configDir = path.join(tmpDir, "config");
    fs.mkdirSync(cwd);
    const localPath = path.join(cwd, "gcp-oauth.keys.json");
    fs.writeFileSync(
      localPath,
      JSON.stringify({ installed: { client_id: "copied", client_secret: "ok" } }),
    );
    const targetPath = path.join(configDir, "gcp-oauth.keys.json");
    const result = loadOAuthKeys({
      oauthPath: targetPath,
      cwd,
      configDir,
      env: {},
    });
    expect(result.client_id).toBe("copied");
    expect(fs.existsSync(targetPath)).toBe(true);
  });
});

describe("findAvailablePort", () => {
  it("returns the preferred port when free", async () => {
    const port = await findAvailablePort(45123);
    expect(port).toBe(45123);
  });

  it("falls back to a neighbouring port when the preferred is in use", async () => {
    // Hold port :45200 so the probe finds it busy.
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(45200, "127.0.0.1", resolve));
    try {
      const port = await findAvailablePort(45200);
      expect(port).not.toBe(45200);
      expect(port).toBeGreaterThan(45200);
      expect(port).toBeLessThan(45211);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("OAuth callback HTML pages", () => {
  it("renders the success page with scope chips + auto-close script", () => {
    const html = _testing.renderSuccessPage(["gmail.modify", "gmail.send"]);
    expect(html).toContain("Authentication successful");
    expect(html).toContain("gmail.modify");
    expect(html).toContain("gmail.send");
    expect(html).toContain("window.close()");
  });

  it("renders the error page with the supplied message, escaped", () => {
    const html = _testing.renderErrorPage("OAuth consent denied: <script>alert(1)</script>");
    expect(html).toContain("Authentication failed");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
  });
});

describe("createOAuthClient", () => {
  it("constructs an OAuth2Client with the supplied keys + default callback", () => {
    const client = createOAuthClient({ client_id: "id-123", client_secret: "shh" });
    // google-auth-library exposes _clientId / _clientSecret / redirectUri internally;
    // we only assert observable surface: it should be an object exposing
    // generateAuthUrl and getToken methods.
    expect(client).toBeDefined();
    expect(typeof client.generateAuthUrl).toBe("function");
    expect(typeof client.getToken).toBe("function");
    // The redirect URI should appear in the generated consent URL.
    const url = client.generateAuthUrl({ scope: ["openid"] });
    expect(url).toContain(encodeURIComponent("http://localhost:3000/oauth2callback"));
    expect(url).toContain("id-123");
  });

  it("honours an explicit callback URL", () => {
    const client = createOAuthClient(
      { client_id: "id-x", client_secret: "y" },
      "http://localhost:4040/oauth2callback",
    );
    const url = client.generateAuthUrl({ scope: ["openid"] });
    expect(url).toContain(encodeURIComponent("http://localhost:4040/oauth2callback"));
  });

  it("rejects HTTPS callbacks because the built-in listener is plain HTTP", () => {
    expect(() =>
      createOAuthClient(
        { client_id: "id-x", client_secret: "y" },
        "https://localhost/oauth2callback",
      ),
    ).toThrow(/must use http:\/\//);
  });

  it("accepts a portless HTTP callback (which resolves to port 80)", () => {
    expect(() =>
      createOAuthClient(
        { client_id: "id-x", client_secret: "y" },
        "http://localhost/oauth2callback",
      ),
    ).not.toThrow();
  });
});

describe("saveCredentialsToFile", () => {
  it("writes {tokens, scopes} JSON to the target path", () => {
    const target = path.join(tmpDir, "credentials.json");
    saveCredentialsToFile({
      path: target,
      tokens: { access_token: "at", refresh_token: "rt" },
      scopes: ["gmail.modify"],
    });
    const raw = fs.readFileSync(target, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      tokens: { access_token: "at", refresh_token: "rt" },
      scopes: ["gmail.modify"],
    });
  });

  it("creates the config dir with mode 0700 if missing", () => {
    const configDir = path.join(tmpDir, "fresh-config");
    const target = path.join(configDir, "credentials.json");
    expect(fs.existsSync(configDir)).toBe(false);
    saveCredentialsToFile({
      path: target,
      tokens: { access_token: "at" },
      scopes: ["gmail.readonly"],
      configDir,
    });
    expect(fs.existsSync(configDir)).toBe(true);
    if (process.platform !== "win32") {
      const dirMode = fs.statSync(configDir).mode & 0o777;
      expect(dirMode).toBe(0o700);
    }
  });

  it("writes the credentials file with mode 0600 (POSIX)", () => {
    const target = path.join(tmpDir, "creds-mode.json");
    saveCredentialsToFile({
      path: target,
      tokens: { access_token: "secret-token" },
      scopes: ["gmail.modify"],
    });
    if (process.platform !== "win32") {
      const fileMode = fs.statSync(target).mode & 0o777;
      expect(fileMode).toBe(0o600);
    }
  });
});

describe("formatCredentialsForExport", () => {
  it("returns canonical JSON matching the saveCredentialsToFile shape", () => {
    const tokens = { access_token: "at", refresh_token: "rt", expiry_date: 1234567890 };
    const scopes = ["gmail.modify", "gmail.settings.basic"];
    const json = formatCredentialsForExport(tokens, scopes);
    // Round-trips through JSON.parse.
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({ tokens, scopes });
    // Stable shape — keys in {tokens, scopes} order; no extra whitespace.
    expect(json).toBe(JSON.stringify({ tokens, scopes }));
  });

  it("handles empty scopes array", () => {
    const json = formatCredentialsForExport({ access_token: "at" }, []);
    expect(JSON.parse(json)).toEqual({ tokens: { access_token: "at" }, scopes: [] });
  });
});
