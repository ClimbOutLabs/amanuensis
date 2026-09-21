import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SendEmailSchema } from "./tools.js";
import {
  createEmailWithNodemailer,
  MAX_INLINE_IMAGE_CONTENT_BYTES,
  needsRawBuilder,
} from "./utl.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("inline image schema", () => {
  const base = {
    to: ["to@example.com"],
    subject: "inline",
    body: "fallback",
    htmlBody: '<img src="cid:hero">',
  };

  it("requires exactly one source, valid CID, HTML, and MIME for base64", () => {
    expect(() =>
      SendEmailSchema.parse({
        ...base,
        htmlBody: undefined,
        inlineImages: [{ cid: "hero", path: "/x" }],
      }),
    ).toThrow(/htmlBody/);
    expect(() =>
      SendEmailSchema.parse({ ...base, inlineImages: [{ cid: "bad cid", path: "/x" }] }),
    ).toThrow(/cid/);
    expect(() =>
      SendEmailSchema.parse({ ...base, inlineImages: [{ cid: "hero", content: "YQ==" }] }),
    ).toThrow(/contentType/);
    expect(() =>
      SendEmailSchema.parse({
        ...base,
        inlineImages: [{ cid: "hero", path: "/x", content: "YQ==", contentType: "image/png" }],
      }),
    ).toThrow(/exactly one/);
  });
});

describe("inline image MIME output", () => {
  it("embeds a path image as an inline CID MIME part", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-inline-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "hero.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // The inline-image sandbox only reads from GMAIL_ATTACHMENTS_DIR.
    const saved = process.env.GMAIL_ATTACHMENTS_DIR;
    process.env.GMAIL_ATTACHMENTS_DIR = dir;
    try {
      const raw = await createEmailWithNodemailer({
        to: ["to@example.com"],
        subject: "inline",
        body: "fallback",
        htmlBody: '<img src="cid:hero">',
        inlineImages: [{ cid: "hero", path: imagePath }],
      });
      expect(raw).toMatch(/Content-ID: <hero>/i);
      expect(raw).toMatch(/Content-Disposition: inline/i);
      expect(raw).toMatch(/Content-Type: image\/png/i);
      expect(needsRawBuilder({ inlineImages: [{ cid: "hero" }] })).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GMAIL_ATTACHMENTS_DIR;
      else process.env.GMAIL_ATTACHMENTS_DIR = saved;
    }
  });

  it("rejects invalid base64 and decoded content larger than 10 MB", async () => {
    const args = {
      to: ["to@example.com"],
      subject: "inline",
      body: "fallback",
      htmlBody: '<img src="cid:hero">',
    };
    await expect(
      createEmailWithNodemailer({
        ...args,
        inlineImages: [{ cid: "hero", content: "not base64!", contentType: "image/png" }],
      }),
    ).rejects.toThrow(/valid base64/);
    const oversized = Buffer.alloc(MAX_INLINE_IMAGE_CONTENT_BYTES + 1).toString("base64");
    await expect(
      createEmailWithNodemailer({
        ...args,
        inlineImages: [{ cid: "hero", content: oversized, contentType: "image/png" }],
      }),
    ).rejects.toThrow(/10 MB/);
  });
});
