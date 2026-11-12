/** Invented office documents and e-mails, built at test time so no binary is checked in. */
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import { execFileSync } from 'node:child_process';

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

const ODF_NAMESPACES =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"';

/** An OpenDocument spreadsheet (.ods) or presentation (.odp) whose body is the given markup. */
export function syntheticOdf(kind: 'spreadsheet' | 'presentation', body: string): Buffer {
  return zipOf({
    mimetype: `application/vnd.oasis.opendocument.${kind}`,
    'content.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NAMESPACES}><office:body><office:${kind}>${body}</office:${kind}></office:body></office:document-content>`,
  });
}

const SHEET_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const RELS_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function relationships(entries: readonly (readonly [string, string, string])[]): string {
  return `<Relationships ${RELS_NS}>${entries
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL_TYPE}/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`;
}

/**
 * An .xlsx with one sheet per entry. Cells are `<c>` markup, so a test can use shared strings (`t="s"`), inline
 * strings, numbers and styles. Style 1 is a date format.
 */
export function syntheticXlsx({
  sheets,
  sharedStrings = [],
}: {
  sheets: readonly { name: string; rows: string; hidden?: boolean }[];
  sharedStrings?: readonly string[];
}): Buffer {
  const entries: Record<string, string> = {
    '_rels/.rels': relationships([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `<workbook ${SHEET_NS} ${REL_NS}><sheets>${sheets
      .map(
        (sheet, index) =>
          `<sheet name="${sheet.name}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"${sheet.hidden === true ? ' state="hidden"' : ''}/>`,
      )
      .join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relationships([
      ...sheets.map(
        (_, index) => [`rId${String(index + 1)}`, 'worksheet', `worksheets/sheet${String(index + 1)}.xml`] as const,
      ),
      ['rIdS', 'sharedStrings', 'sharedStrings.xml'],
      ['rIdT', 'styles', 'styles.xml'],
    ]),
    'xl/sharedStrings.xml': `<sst ${SHEET_NS}>${sharedStrings.map(text => `<si><t>${text}</t></si>`).join('')}</sst>`,
    'xl/styles.xml': `<styleSheet ${SHEET_NS}><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
  };
  sheets.forEach((sheet, index) => {
    entries[`xl/worksheets/sheet${String(index + 1)}.xml`] =
      `<worksheet ${SHEET_NS}><sheetData>${sheet.rows}</sheetData></worksheet>`;
  });
  return zipOf(entries);
}

const DRAWING_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const PRESENTATION_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** A .pptx with one slide per entry; each slide's paragraphs become text boxes, and notes go on its notes page. */
export function syntheticPptx(slides: readonly { paragraphs: readonly string[]; notes?: string }[]): Buffer {
  const shape = (paragraphs: readonly string[], extra = ''): string =>
    `<p:sp><p:nvSpPr>${extra}</p:nvSpPr><p:txBody>${paragraphs.map(text => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
  const entries: Record<string, string> = {
    '_rels/.rels': relationships([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': `<p:presentation ${PRESENTATION_NS} ${REL_NS}><p:sldIdLst>${slides
      .map((_, index) => `<p:sldId id="${String(256 + index)}" r:id="rId${String(index + 1)}"/>`)
      .join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relationships(
      slides.map((_, index) => [`rId${String(index + 1)}`, 'slide', `slides/slide${String(index + 1)}.xml`] as const),
    ),
  };
  slides.forEach((slide, index) => {
    const n = String(index + 1);
    entries[`ppt/slides/slide${n}.xml`] =
      `<p:sld ${PRESENTATION_NS} ${DRAWING_NS}><p:cSld><p:spTree>${shape(slide.paragraphs)}${shape([n], '<p:nvPr><p:ph type="sldNum"/></p:nvPr>')}</p:spTree></p:cSld></p:sld>`;
    if (slide.notes !== undefined) {
      entries[`ppt/slides/_rels/slide${n}.xml.rels`] = relationships([
        ['rId1', 'notesSlide', `../notesSlides/notesSlide${n}.xml`],
      ]);
      entries[`ppt/notesSlides/notesSlide${n}.xml`] =
        `<p:notes ${PRESENTATION_NS} ${DRAWING_NS}><p:cSld><p:spTree>${shape([slide.notes])}${shape([n], '<p:nvPr><p:ph type="sldNum"/></p:nvPr>')}</p:spTree></p:cSld></p:notes>`;
    }
  });
  return zipOf(entries);
}

/**
 * Writes invented compound files (.doc, .xls, .msg, and the wrapper a password-protected .docx is saved in) with
 * a small writer in Python's standard library, so the readers are tested against the real container layout:
 * a FAT, a mini stream, a directory tree and storages.
 */
const COMPOUND_FILE_SCRIPT = String.raw`import sys, json, struct

# Builds invented compound files (.doc, .xls, .msg) for tests. Input: a JSON spec on argv[1]; output: the bytes.
FREE, END, FATSECT = 0xFFFFFFFF, 0xFFFFFFFE, 0xFFFFFFFD


def cfb(tree):
    """tree: {name: bytes | dict} under the root storage. Small streams go to the mini stream."""
    entries = [{'name': 'Root Entry', 'type': 5, 'kids': [], 'data': None}]

    def add(node, parent):
        for name, value in node.items():
            index = len(entries)
            if isinstance(value, dict):
                entries.append({'name': name, 'type': 1, 'kids': [], 'data': None})
                entries[parent]['kids'].append(index)
                add(value, index)
            else:
                entries.append({'name': name, 'type': 2, 'kids': [], 'data': value})
                entries[parent]['kids'].append(index)

    add(tree, 0)
    mini, minifat = bytearray(), []
    big = []
    for e in entries:
        data = e['data']
        if data is None:
            continue
        if len(data) < 4096:
            first = len(mini) // 64
            count = max(1, (len(data) + 63) // 64)
            for k in range(count):
                minifat.append(first + k + 1 if k < count - 1 else END)
            mini += data + b'\0' * (count * 64 - len(data))
            e['start'] = first
        else:
            big.append(e)
    sectors = []
    fat = []

    def place(data):
        count = max(1, (len(data) + 511) // 512)
        first = len(sectors)
        for k in range(count):
            sectors.append(data[k * 512:(k + 1) * 512].ljust(512, b'\0'))
            fat.append(first + k + 1 if k < count - 1 else END)
        return first

    for e in big:
        e['start'] = place(e['data'])
    root_start = place(bytes(mini)) if mini else END
    minifat_bytes = b''.join(struct.pack('<I', v) for v in minifat)
    minifat_start = place(minifat_bytes) if minifat else END
    directory = bytearray()
    for i, e in enumerate(entries):
        kids = e['kids']
        name = e['name'].encode('utf-16-le') + b'\0\0'
        entry = bytearray(128)
        entry[0:len(name)] = name
        struct.pack_into('<H', entry, 0x40, len(name))
        entry[0x42] = e['type']
        entry[0x43] = 1
        struct.pack_into('<III', entry, 0x44, FREE, FREE, kids[0] if kids else FREE)
        if i == 0:
            struct.pack_into('<II', entry, 0x74, root_start, len(mini))
        elif e['type'] == 2:
            struct.pack_into('<II', entry, 0x74, e['start'], len(e['data']))
        directory += entry
    for e in entries:
        kids = e['kids']
        for a, b in zip(kids, kids[1:]):
            struct.pack_into('<I', directory, a * 128 + 0x48, b)
    while len(directory) % 512:
        directory += bytearray(128)
    dir_start = place(bytes(directory))
    nfat = 1
    while (len(sectors) + nfat) > nfat * 128:
        nfat += 1
    fat_start = len(sectors)
    fat.extend([FATSECT] * nfat)
    fat_bytes = b''.join(struct.pack('<I', v) for v in fat).ljust(nfat * 512, b'\xff')
    for k in range(nfat):
        sectors.append(fat_bytes[k * 512:(k + 1) * 512])
    header = bytearray(512)
    header[0:8] = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'
    struct.pack_into('<HHHH', header, 0x18, 0x3E, 3, 0xFFFE, 9)
    struct.pack_into('<H', header, 0x20, 6)
    struct.pack_into('<IIIIIIII', header, 0x2C, nfat, dir_start, 0, 4096, minifat_start, (len(minifat_bytes) + 511) // 512, END, 0)
    difat = [fat_start + k for k in range(nfat)] + [FREE] * (109 - nfat)
    struct.pack_into('<109I', header, 0x4C, *difat)
    return bytes(header) + b''.join(sectors)


def word_doc(paragraphs, encrypted=False):
    text = ('\r'.join(paragraphs) + '\r').encode('utf-16-le')
    fib = bytearray(0x400)
    struct.pack_into('<HH', fib, 0, 0xA5EC, 0xC1)
    struct.pack_into('<H', fib, 0x0A, 0x0200 | (0x0100 if encrypted else 0))
    struct.pack_into('<H', fib, 32, 14)
    lw_at = 34 + 28
    struct.pack_into('<H', fib, lw_at, 22)
    chars = len(text) // 2
    struct.pack_into('<i', fib, lw_at + 2 + 3 * 4, chars)
    fc_at = lw_at + 2 + 22 * 4
    struct.pack_into('<H', fib, fc_at, 0x5D)
    text_at = 0x200
    plc = struct.pack('<II', 0, chars) + struct.pack('<HIH', 0, text_at, 0)
    clx = b'\x02' + struct.pack('<I', len(plc)) + plc
    struct.pack_into('<II', fib, fc_at + 2 + 33 * 8, 0, len(clx))
    word = bytes(fib[:text_at]) + text
    return cfb({'WordDocument': word, '1Table': clx})


def record(rid, data):
    return struct.pack('<HH', rid, len(data)) + data


def xls(sheet_name, strings, cells, protected=False):
    """cells: list of [row, col, kind, value] with kind 'sst', 'number', 'rk', 'date'."""
    def short(text):
        return struct.pack('<BB', len(text), 1) + text.encode('utf-16-le')

    def long_string(text):
        return struct.pack('<HB', len(text), 1) + text.encode('utf-16-le')

    sst = struct.pack('<II', len(strings), len(strings)) + b''.join(long_string(s) for s in strings)
    globals_ = [record(0x0809, struct.pack('<HHHHII', 0x0600, 0x0005, 0, 0, 0, 0))]
    if protected:
        globals_.append(record(0x002F, b'\x01\x00' + b'\0' * 52))
    globals_.append(record(0x041E, struct.pack('<H', 164) + long_string('yyyy-mm-dd')))
    globals_.append(record(0x00E0, struct.pack('<HH', 0, 0) + b'\0' * 16))
    globals_.append(record(0x00E0, struct.pack('<HH', 0, 164) + b'\0' * 16))
    boundsheet_at = len(b''.join(globals_))
    globals_.append(record(0x0085, struct.pack('<IBB', 0, 0, 0) + short(sheet_name)))
    globals_.append(record(0x00FC, sst))
    globals_.append(record(0x000A, b''))
    head = bytearray(b''.join(globals_))
    sheet = [record(0x0809, struct.pack('<HHHHII', 0x0600, 0x0010, 0, 0, 0, 0))]
    for row, col, kind, value in cells:
        if kind == 'sst':
            sheet.append(record(0x00FD, struct.pack('<HHHI', row, col, 0, value)))
        elif kind == 'number':
            sheet.append(record(0x0203, struct.pack('<HHHd', row, col, 0, value)))
        elif kind == 'date':
            sheet.append(record(0x0203, struct.pack('<HHHd', row, col, 1, value)))
        elif kind == 'rk':
            sheet.append(record(0x027E, struct.pack('<HHHI', row, col, 0, (value << 2) | 2)))
    sheet.append(record(0x000A, b''))
    struct.pack_into('<I', head, boundsheet_at + 4, len(head))
    return cfb({'Workbook': bytes(head) + b''.join(sheet)})


def msg(fields, attachments):
    def prop(tag, text):
        return {'__substg1.0_' + tag + '001F': text.encode('utf-16-le')}

    tree = {}
    for tag, text in fields.items():
        tree.update(prop(tag, text))
    tree['__properties_version1.0'] = b'\0' * 32
    for index, (name, data) in enumerate(attachments):
        storage = prop('3707', name)
        storage['__substg1.0_37010102'] = data.encode('latin-1')
        storage['__properties_version1.0'] = b'\0' * 8
        tree['__attach_version1.0_#%08X' % index] = storage
    return cfb(tree)


spec = json.loads(sys.argv[1])
kind = spec['kind']
if kind == 'doc':
    out = word_doc(spec['paragraphs'], spec.get('encrypted', False))
elif kind == 'xls':
    out = xls(spec['sheet'], spec['strings'], spec['cells'], spec.get('protected', False))
elif kind == 'msg':
    out = msg(spec['fields'], spec.get('attachments', []))
elif kind == 'encrypted-ooxml':
    out = cfb({'EncryptionInfo': b'\0' * 64, 'EncryptedPackage': b'\0' * 64})
sys.stdout.buffer.write(out)
`;

export type CompoundFileSpec =
  | { kind: 'doc'; paragraphs: readonly string[]; encrypted?: boolean }
  | {
      kind: 'xls';
      sheet: string;
      strings: readonly string[];
      cells: readonly (readonly [number, number, 'sst' | 'number' | 'rk' | 'date', number])[];
      protected?: boolean;
    }
  | { kind: 'msg'; fields: Record<string, string>; attachments?: readonly (readonly [string, string])[] }
  | { kind: 'encrypted-ooxml' };

export function syntheticCompoundFile(spec: CompoundFileSpec): Buffer {
  return execFileSync('python3', ['-I', '-S', '-c', COMPOUND_FILE_SCRIPT, JSON.stringify(spec)], {
    maxBuffer: 64 * 1024 * 1024,
  });
}
