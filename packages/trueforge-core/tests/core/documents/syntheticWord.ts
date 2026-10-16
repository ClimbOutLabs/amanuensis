/** Invented Word and OpenDocument files, built at test time so no binary is checked in. */
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import { execFileSync } from 'node:child_process';

/** The sandbox reads Word files with python-docx; tests that run the real reader need the same on the host. */
export function hostCanReadWord(): boolean {
  try {
    execFileSync('python3', ['-I', '-c', 'import docx, lxml'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function paragraph(text: string): Paragraph {
  return new Paragraph({ text });
}

function row(cells: readonly string[]): TableRow {
  return new TableRow({ children: cells.map(cell => new TableCell({ children: [paragraph(cell)] })) });
}

/** A .docx with the paragraphs, then a two-column table, as a real Word file. */
export async function syntheticDocx({
  paragraphs,
  table = [],
}: {
  paragraphs: readonly string[];
  table?: readonly (readonly [string, string])[];
}): Promise<Buffer> {
  const document = new Document({
    sections: [
      {
        children: [
          ...paragraphs.map(paragraph),
          ...(table.length === 0 ? [] : [new Table({ rows: table.map(cells => row(cells)) })]),
        ],
      },
    ],
  });
  return await Packer.toBuffer(document);
}

/** Zips the named entries with the zip tool in Python's standard library. */
export function zipOf(entries: Record<string, string>, options: { repeatBytes?: number } = {}): Buffer {
  const script = [
    'import sys, json, zipfile, io',
    'entries, repeat = json.loads(sys.argv[1]), int(sys.argv[2])',
    'buffer = io.BytesIO()',
    'z = zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED)',
    'for name, text in entries.items(): z.writestr(name, text)',
    'if repeat: z.writestr("padding.bin", b"\\0" * repeat)',
    'z.close()',
    'sys.stdout.buffer.write(buffer.getvalue())',
  ].join('\n');
  return execFileSync('python3', ['-I', '-c', script, JSON.stringify(entries), String(options.repeatBytes ?? 0)], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

const ODT_NAMESPACES =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';

/** An .odt whose body is the given text markup (`<text:p>` and friends). */
export function syntheticOdt(body: string): Buffer {
  return zipOf({
    mimetype: 'application/vnd.oasis.opendocument.text',
    'content.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODT_NAMESPACES}><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
  });
}
