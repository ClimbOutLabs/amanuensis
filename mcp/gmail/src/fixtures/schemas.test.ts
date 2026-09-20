// Validates every committed fixture under fixtures/gmail/ against the Zod
// schemas in gmail-schemas.ts, AND runs a real-data-leak guard that fails
// CI if any fixture contains a known-real domain. This is the safety net
// for the anonymisation pipeline — if a future fixture-capture step
// accidentally commits real data, this test catches it.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AttachmentBodySchema,
  DraftSchema,
  FilterSchema,
  LabelSchema,
  MessageSchema,
  ProfileSchema,
  ThreadSchema,
} from "./gmail-schemas.js";

const FIXTURE_ROOT = path.resolve(__dirname, "..", "..", "fixtures", "gmail");

// Domains / strings that MUST NOT appear in any committed fixture. Extend
// this list when a new contributor's email could plausibly leak. Each
// fixture file is grepped for these substrings (case-insensitive).
const REAL_DATA_DENYLIST = [
  "alex.rivera",
  "alex.rivera@example.com",
  "@anthropic.com",
  // Avoid bare "@example.com" — too aggressive; legitimate synthetic mailers
  // could use it. Document this in the AGENTS guide instead and rely on
  // the more specific patterns above.
] as const;

function listAccountDirs(): string[] {
  if (!fs.existsSync(FIXTURE_ROOT)) return [];
  return fs
    .readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(FIXTURE_ROOT, d.name));
}

function listFixtureFiles(accountDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(full);
    }
  };
  walk(accountDir);
  return files;
}

describe("fixture corpus structure", () => {
  it("ships at least one account directory", () => {
    expect(listAccountDirs().length).toBeGreaterThan(0);
  });
});

describe("fixture schema validation", () => {
  for (const accountDir of listAccountDirs()) {
    const accountName = path.basename(accountDir);

    it(`${accountName}/profile.json parses cleanly`, () => {
      const raw = JSON.parse(fs.readFileSync(path.join(accountDir, "profile.json"), "utf8"));
      expect(() => ProfileSchema.parse(raw)).not.toThrow();
    });

    it(`${accountName}/scopes.json is a string array`, () => {
      const raw = JSON.parse(fs.readFileSync(path.join(accountDir, "scopes.json"), "utf8"));
      expect(Array.isArray(raw)).toBe(true);
      for (const s of raw as unknown[]) expect(typeof s).toBe("string");
    });

    it(`${accountName}/labels.json parses as Label[]`, () => {
      const raw = JSON.parse(fs.readFileSync(path.join(accountDir, "labels.json"), "utf8"));
      expect(Array.isArray(raw)).toBe(true);
      for (const item of raw as unknown[]) {
        expect(() => LabelSchema.parse(item)).not.toThrow();
      }
    });

    it(`${accountName}/filters.json parses as Filter[]`, () => {
      const raw = JSON.parse(fs.readFileSync(path.join(accountDir, "filters.json"), "utf8"));
      expect(Array.isArray(raw)).toBe(true);
      for (const item of raw as unknown[]) {
        expect(() => FilterSchema.parse(item)).not.toThrow();
      }
    });

    const messagesDir = path.join(accountDir, "messages");
    if (fs.existsSync(messagesDir)) {
      for (const f of fs.readdirSync(messagesDir).filter((n) => n.endsWith(".json"))) {
        it(`${accountName}/messages/${f} parses as Message`, () => {
          const raw = JSON.parse(fs.readFileSync(path.join(messagesDir, f), "utf8"));
          expect(() => MessageSchema.parse(raw)).not.toThrow();
        });
      }
    }

    const threadsDir = path.join(accountDir, "threads");
    if (fs.existsSync(threadsDir)) {
      for (const f of fs.readdirSync(threadsDir).filter((n) => n.endsWith(".json"))) {
        it(`${accountName}/threads/${f} parses as Thread`, () => {
          const raw = JSON.parse(fs.readFileSync(path.join(threadsDir, f), "utf8"));
          expect(() => ThreadSchema.parse(raw)).not.toThrow();
        });
      }
    }

    const draftsDir = path.join(accountDir, "drafts");
    if (fs.existsSync(draftsDir)) {
      for (const f of fs.readdirSync(draftsDir).filter((n) => n.endsWith(".json"))) {
        it(`${accountName}/drafts/${f} parses as Draft`, () => {
          const raw = JSON.parse(fs.readFileSync(path.join(draftsDir, f), "utf8"));
          expect(() => DraftSchema.parse(raw)).not.toThrow();
        });
      }
    }

    const attachmentsDir = path.join(accountDir, "attachments");
    if (fs.existsSync(attachmentsDir)) {
      for (const f of fs.readdirSync(attachmentsDir).filter((n) => n.endsWith(".json"))) {
        it(`${accountName}/attachments/${f} parses as AttachmentBody`, () => {
          const raw = JSON.parse(fs.readFileSync(path.join(attachmentsDir, f), "utf8"));
          expect(() => AttachmentBodySchema.parse(raw)).not.toThrow();
        });
      }
    }
  }
});

describe("no-real-data guard (anti-leak)", () => {
  // Single test that opens every fixture once and scans for denylisted
  // substrings. Bails on the first hit with a clear message so the
  // contributor can see which file leaked what.
  it("no committed fixture contains any denylisted string", () => {
    const offenders: Array<{ file: string; match: string }> = [];
    for (const accountDir of listAccountDirs()) {
      for (const file of listFixtureFiles(accountDir)) {
        const content = fs.readFileSync(file, "utf8").toLowerCase();
        for (const pattern of REAL_DATA_DENYLIST) {
          if (content.includes(pattern.toLowerCase())) {
            offenders.push({ file: path.relative(FIXTURE_ROOT, file), match: pattern });
          }
        }
      }
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });
});
