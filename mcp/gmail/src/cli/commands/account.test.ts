import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, getAccountDir, loadManifest, saveManifest } from "../../core/accounts.js";
import { runAccountAuthCommand } from "../account-auth.js";
import { buildProgram } from "../index.js";

vi.mock("../account-auth.js", () => ({
  runAccountAuthCommand: vi.fn(async () => {}),
}));

let tmpDir: string;
let originalConfigDir: string | undefined;
let originalAccount: string | undefined;

const stubStdio = () => {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  });
  return { out, err, outSpy, errSpy };
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-account-cli-"));
  originalConfigDir = process.env.GMAIL_CONFIG_DIR;
  originalAccount = process.env.GMAIL_ACCOUNT;
  process.env.GMAIL_CONFIG_DIR = tmpDir;
  delete process.env.GMAIL_ACCOUNT;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.GMAIL_CONFIG_DIR;
  else process.env.GMAIL_CONFIG_DIR = originalConfigDir;
  if (originalAccount === undefined) delete process.env.GMAIL_ACCOUNT;
  else process.env.GMAIL_ACCOUNT = originalAccount;
});

describe("gmail account list", () => {
  it("reports an empty manifest gracefully", async () => {
    const stdio = stubStdio();
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "gmail", "account", "list"]);
    expect(stdio.out.join("")).toMatch(/No accounts in the manifest/);
  });

  it("prints a table with rows + flags the default", async () => {
    addAccount("work", { emailAddress: "w@example.com", scopes: ["gmail.modify"] });
    addAccount("personal", { emailAddress: "p@example.com" });
    const stdio = stubStdio();
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "gmail", "account", "list"]);
    const joined = stdio.out.join("");
    expect(joined).toContain("work");
    expect(joined).toContain("w@example.com");
    expect(joined).toContain("personal");
    // First-added account (work) is the default → has a marker on its row.
    const workLine = joined.split("\n").find((l) => l.includes("work"));
    expect(workLine).toMatch(/✓/);
  });

  it("--json emits a JSON array", async () => {
    addAccount("work", { emailAddress: "w@example.com" });
    const stdio = stubStdio();
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "gmail", "account", "list", "--json"]);
    const out = stdio.out.join("");
    const parsed = JSON.parse(out);
    expect(parsed).toEqual([
      {
        id: "work",
        entry: expect.objectContaining({ emailAddress: "w@example.com" }),
        isDefault: true,
      },
    ]);
  });
});

describe("gmail account current", () => {
  it("reports 'no active account' when nothing is configured", async () => {
    const stdio = stubStdio();
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "gmail", "account", "current"]);
    expect(stdio.out.join("")).toMatch(/No active account/);
  });

  it("reports the manifest default", async () => {
    addAccount("work", {});
    addAccount("personal", {});
    const stdio = stubStdio();
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "gmail", "account", "current"]);
    const out = stdio.out.join("");
    expect(out).toMatch(/^work\s+\(source: manifest-default\)/);
  });
});

describe("gmail account use", () => {
  it("flips the default and persists", async () => {
    addAccount("work", {});
    addAccount("personal", {});
    const stdio = stubStdio();
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "gmail", "account", "use", "personal"]);
    expect(stdio.out.join("")).toMatch(/Default account set to "personal"/);
    expect(loadManifest()?.defaultAccount).toBe("personal");
  });
});

describe("gmail account rm", () => {
  it("removes from manifest and deletes the on-disk directory (--force)", async () => {
    addAccount("work", {});
    addAccount("personal", {});
    const workDir = getAccountDir("work");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "credentials.json"), `{"tokens":{}}`);

    const stdio = stubStdio();
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "gmail", "account", "rm", "work", "--force"]);

    expect(stdio.out.join("")).toMatch(/Account "work" removed/);
    expect(loadManifest()?.accounts.work).toBeUndefined();
    expect(fs.existsSync(workDir)).toBe(false);
  });

  it("--keep-files leaves the directory intact", async () => {
    addAccount("work", {});
    const workDir = getAccountDir("work");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "credentials.json"), `{"tokens":{}}`);

    stubStdio();
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "gmail", "account", "rm", "work", "--force", "--keep-files"]);

    expect(loadManifest()?.accounts.work).toBeUndefined();
    expect(fs.existsSync(path.join(workDir, "credentials.json"))).toBe(true);
  });
});

describe("gmail account auth", () => {
  it("delegates OAuth to the account auth runner with the named account id", async () => {
    stubStdio();
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync([
      "node",
      "gmail",
      "account",
      "auth",
      "work",
      "--scopes",
      "gmail.send",
      "--non-interactive",
      "--headless",
    ]);

    expect(runAccountAuthCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "work",
        scopes: "gmail.send",
        nonInteractive: true,
        headless: true,
      }),
    );
  });
});

describe("gmail account check", () => {
  it("--all --json reports missing credentials without leaking secrets", async () => {
    addAccount("work", { emailAddress: "w@example.com", scopes: ["gmail.send"] });
    const stdio = stubStdio();
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "gmail", "account", "check", "--all", "--json"]);

    const parsed = JSON.parse(stdio.out.join(""));
    expect(parsed).toEqual([
      expect.objectContaining({
        id: "work",
        status: "missing_credentials",
        credentialsPath: expect.stringContaining("accounts/work/credentials.json"),
      }),
    ]);
    expect(stdio.out.join("")).not.toContain("access_token");
    expect(stdio.out.join("")).not.toContain("refresh_token");
  });
});

describe("gmail account rename", () => {
  it("renames the manifest entry and moves the credentials directory", async () => {
    addAccount("work", { emailAddress: "w@example.com", scopes: ["gmail.send"] });
    const workDir = getAccountDir("work");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "credentials.json"),
      `{"tokens":{"access_token":"secret"}}`,
    );

    const stdio = stubStdio();
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "gmail", "account", "rename", "work", "personal"]);

    expect(stdio.out.join("")).toMatch(/Account "work" renamed to "personal"/);
    const manifest = loadManifest();
    expect(manifest?.accounts.work).toBeUndefined();
    expect(manifest?.accounts.personal).toEqual(
      expect.objectContaining({
        emailAddress: "w@example.com",
        scopes: ["gmail.send"],
      }),
    );
    expect(manifest?.defaultAccount).toBe("personal");
    expect(fs.existsSync(workDir)).toBe(false);
    expect(fs.existsSync(path.join(getAccountDir("personal"), "credentials.json"))).toBe(true);
  });
});

describe("bare gmail account", () => {
  it("prints account usage and exits with a usage code when stdin is not a TTY", async () => {
    const stdio = stubStdio();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_called__:${code ?? 0}`);
    }) as typeof process.exit);

    const program = buildProgram();
    program.exitOverride();
    await expect(program.parseAsync(["node", "gmail", "account"])).rejects.toThrow(
      /^__exit_called__:3$/,
    );
    expect(stdio.out.join("")).toContain("Usage:");
    expect(stdio.out.join("")).toContain("account auth");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });
});

describe("interactive account manager refresh", () => {
  it("checks all configured accounts before rendering the TTY manager table", async () => {
    addAccount("work", {});
    let calls = 0;
    const { refreshAccountsForInteractiveManager } = await import("./account.js");

    await refreshAccountsForInteractiveManager({
      checkAll: async () => {
        calls += 1;
        return [];
      },
      write: () => {},
    });

    expect(calls).toBe(1);
  });

  it("skips the auth-health check when no accounts exist yet", async () => {
    let calls = 0;
    const { refreshAccountsForInteractiveManager } = await import("./account.js");

    await refreshAccountsForInteractiveManager({
      checkAll: async () => {
        calls += 1;
        return [];
      },
      write: () => {},
    });

    expect(calls).toBe(0);
  });
});

describe("deprecated gmail auth", () => {
  it("exits with a pointer to gmail account", async () => {
    const stdio = stubStdio();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_called__:${code ?? 0}`);
    }) as typeof process.exit);

    const program = buildProgram();
    program.exitOverride();
    await expect(program.parseAsync(["node", "gmail", "auth"])).rejects.toThrow(
      /^__exit_called__:1$/,
    );
    expect(stdio.err.join("")).toContain("gmail auth has moved. Use gmail account instead.");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("global -a/--account flag", () => {
  it("stamps GMAIL_ACCOUNT into the env via the preAction hook", async () => {
    addAccount("work", {});
    addAccount("personal", {});
    stubStdio();
    const program = buildProgram();
    program.exitOverride();
    // `account current` runs after preAction; should report the env-override
    // ("env" source) rather than the manifest-default "work".
    await program.parseAsync(["node", "gmail", "--account", "personal", "account", "current"]);
    expect(process.env.GMAIL_ACCOUNT).toBe("personal");
  });

  it("rejects malformed account ids early via validateAccountId", async () => {
    stubStdio();
    const program = buildProgram();
    program.exitOverride();
    await expect(
      program.parseAsync(["node", "gmail", "--account", "../escape", "account", "current"]),
    ).rejects.toThrow();
  });
});

describe("legacy manifest pre-creation", () => {
  it("saveManifest then list does not corrupt anything (sanity)", () => {
    saveManifest({
      defaultAccount: "alpha",
      accounts: {
        alpha: { createdAt: new Date().toISOString() },
        beta: { createdAt: new Date().toISOString() },
      },
    });
    expect(loadManifest()?.defaultAccount).toBe("alpha");
  });
});
