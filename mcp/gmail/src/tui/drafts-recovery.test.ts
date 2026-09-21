// Unit coverage for the local `.eml` draft-recovery reader. Uses a temp
// GMAIL_CONFIG_DIR so getDraftsDir() resolves under a scratch directory —
// no real filesystem state, no Gmail.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildComposeTemplate } from "./compose-parser.js";
import { discardLocalDraft, listLocalDrafts, readLocalDraft } from "./drafts-recovery.js";

let configDir: string;
let draftsDir: string;
const origConfigDir = process.env.GMAIL_CONFIG_DIR;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-drafts-recovery-"));
  draftsDir = path.join(configDir, "drafts");
  fs.mkdirSync(draftsDir, { recursive: true });
  process.env.GMAIL_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (origConfigDir === undefined) delete process.env.GMAIL_CONFIG_DIR;
  else process.env.GMAIL_CONFIG_DIR = origConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

function writeDraft(filename: string, content: string, mtimeMs: number): void {
  const full = path.join(draftsDir, filename);
  fs.writeFileSync(full, content, "utf8");
  const t = new Date(mtimeMs);
  fs.utimesSync(full, t, t);
}

describe("listLocalDrafts", () => {
  it("returns [] when the drafts directory does not exist", async () => {
    fs.rmSync(draftsDir, { recursive: true, force: true });
    expect(await listLocalDrafts()).toEqual([]);
  });

  it("parses filename kind/timestamp, headers, and a body snippet", async () => {
    writeDraft(
      "compose-2026-07-27-101500.eml",
      buildComposeTemplate({
        to: ["a@fixture.test", "b@fixture.test"],
        subject: "Quarterly plan",
        body: "Here is the outline\nwith two lines.",
      }),
      Date.UTC(2026, 6, 27, 10, 15, 0),
    );
    const drafts = await listLocalDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      filename: "compose-2026-07-27-101500.eml",
      kind: "compose",
      timestamp: "2026-07-27-101500",
      subject: "Quarterly plan",
      to: ["a@fixture.test", "b@fixture.test"],
    });
    expect(drafts[0]?.snippet).toBe("Here is the outline with two lines.");
  });

  it("recovers reply-all breadcrumbs (kind + source ids) so a resume can re-thread", async () => {
    writeDraft(
      "reply-all-2026-07-27-090000.eml",
      buildComposeTemplate({
        to: ["team@fixture.test"],
        subject: "Re: migration",
        body: "quoted…",
        kind: "reply-all",
        sourceMessageId: "m-42",
        sourceThreadId: "t-42",
      }),
      Date.UTC(2026, 6, 27, 9, 0, 0),
    );
    const [draft] = await listLocalDrafts();
    expect(draft?.kind).toBe("reply-all");
    expect(draft?.sourceMessageId).toBe("m-42");
    expect(draft?.sourceThreadId).toBe("t-42");
  });

  it("sorts most-recently-modified first and ignores non-.eml files", async () => {
    writeDraft("compose-2026-07-25-080000.eml", buildComposeTemplate({ subject: "older" }), 1000);
    writeDraft("compose-2026-07-27-080000.eml", buildComposeTemplate({ subject: "newer" }), 5000);
    fs.writeFileSync(path.join(draftsDir, "notes.txt"), "ignore me", "utf8");
    const drafts = await listLocalDrafts();
    expect(drafts.map((d) => d.subject)).toEqual(["newer", "older"]);
  });

  it("readLocalDraft returns raw content and discardLocalDraft removes the file", async () => {
    const raw = buildComposeTemplate({ subject: "to discard" });
    writeDraft("compose-2026-07-27-120000.eml", raw, 2000);
    const [draft] = await listLocalDrafts();
    expect(draft).toBeDefined();
    if (!draft) return;
    expect(await readLocalDraft(draft.path)).toBe(raw);
    await discardLocalDraft(draft.path);
    expect(await fsp.readdir(draftsDir)).not.toContain(draft.filename);
    // Discarding a missing file is a no-op, not a throw.
    await expect(discardLocalDraft(draft.path)).resolves.toBeUndefined();
  });
});
