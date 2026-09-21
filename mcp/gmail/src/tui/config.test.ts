import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTuiConfig } from "./config.js";

describe("loadTuiConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-tui-cfg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns defaults when the config file is absent", () => {
    const cfg = loadTuiConfig({ GMAIL_CONFIG_DIR: tmpDir });
    expect(cfg.theme).toBe("default");
    expect(cfg.editor).toBeUndefined();
    expect(cfg.cacheMB).toBe(50);
  });

  it("reads theme + editor + cacheMB from config.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ theme: "dracula", editor: "nano", cacheMB: 25 }),
    );
    const cfg = loadTuiConfig({ GMAIL_CONFIG_DIR: tmpDir });
    expect(cfg.theme).toBe("dracula");
    expect(cfg.editor).toBe("nano");
    expect(cfg.cacheMB).toBe(25);
  });

  it("env overrides file values", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ theme: "dracula", editor: "nano", cacheMB: 25 }),
    );
    const cfg = loadTuiConfig({
      GMAIL_CONFIG_DIR: tmpDir,
      GMAIL_TUI_THEME: "nord",
      GMAIL_TUI_EDITOR: "vim",
      GMAIL_TUI_CACHE_MB: "100",
    });
    expect(cfg.theme).toBe("nord");
    expect(cfg.editor).toBe("vim");
    expect(cfg.cacheMB).toBe(100);
  });

  it("returns defaults when config.json is malformed (does not throw)", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "{not json");
    const cfg = loadTuiConfig({ GMAIL_CONFIG_DIR: tmpDir });
    expect(cfg.theme).toBe("default");
    expect(cfg.cacheMB).toBe(50);
  });

  it("ignores bogus cacheMB values (negative / 0 / NaN)", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ cacheMB: -1 }));
    const cfg = loadTuiConfig({ GMAIL_CONFIG_DIR: tmpDir });
    expect(cfg.cacheMB).toBe(50);
  });

  it("ignores non-string theme/editor values silently", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ theme: 42, editor: false }),
    );
    const cfg = loadTuiConfig({ GMAIL_CONFIG_DIR: tmpDir });
    expect(cfg.theme).toBe("default");
    expect(cfg.editor).toBeUndefined();
  });
});
