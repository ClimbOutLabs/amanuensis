/** Invented file bytes with real headers, so the extractor's magic-byte checks pass without any checked-in binaries. */

/** A PNG header of the given size; the body is not a decodable image. */
export function syntheticPng({ width = 64, height = 32 }: { width?: number; height?: number } = {}): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

export function syntheticPdf(): Buffer {
  return Buffer.from('%PDF-1.4\n% synthetic\n', 'latin1');
}

/** Bytes that match the type a path's extension names. */
export function syntheticBytesFor(path: string): Buffer {
  return path.toLowerCase().endsWith('.pdf') ? syntheticPdf() : syntheticPng();
}

function pdfFromObjects(objects: readonly (string | Buffer)[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let length = chunks[0]?.length ?? 0;
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${String(index + 1)} 0 obj\n`, 'latin1'),
      typeof body === 'string' ? Buffer.from(body, 'latin1') : body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  });
  const xref = [
    'xref',
    `0 ${String(objects.length + 1)}`,
    '0000000000 65535 f ',
    ...offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n `),
    `trailer\n<</Size ${String(objects.length + 1)}/Root 1 0 R>>`,
    `startxref\n${String(length)}\n%%EOF\n`,
  ].join('\n');
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

function stream(dictionary: string, data: string): string {
  return `<<${dictionary}/Length ${String(Buffer.byteLength(data, 'latin1'))}>>\nstream\n${data}\nendstream`;
}

function utf16Hex(text: string): string {
  return Buffer.from(text, 'utf16le').swap16().toString('hex');
}

/**
 * A PDF whose text is any Unicode, one page per entry, with no font file: each character gets a code and a
 * ToUnicode entry, which is all a text extractor needs. Used for Arabic, Devanagari and accented Latin.
 * `paddingBytes` adds an unused object so the file reaches a chosen size.
 */
export function unicodeTextPdfPages(
  pages: readonly (readonly string[])[],
  { paddingBytes = 0 }: { paddingBytes?: number } = {},
): Buffer {
  const codes = new Map<string, number>();
  const hexLine = (line: string): string =>
    Array.from(line, character => {
      if (!codes.has(character)) {
        codes.set(character, codes.size + 1);
      }
      return (codes.get(character) ?? 0).toString(16).padStart(4, '0');
    }).join('');
  const contents = pages.map(lines =>
    lines.map((line, index) => `BT /F1 16 Tf 72 ${String(720 - index * 28)} Td <${hexLine(line)}> Tj ET`).join('\n'),
  );
  const entries = [...codes].map(
    ([character, code]) => `<${code.toString(16).padStart(4, '0')}> <${utf16Hex(character)}>`,
  );
  const toUnicode = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CMapName /Synthetic def /CMapType 2 def',
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    `${String(entries.length)} beginbfchar`,
    ...entries,
    'endbfchar endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');
  const firstPageObject = 7;
  const pageObjects = pages.flatMap((_, index) => [
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${String(firstPageObject + 1 + index * 2)} 0 R/Resources<</Font<</F1 3 0 R>>>>>>`,
    stream('', contents[index] ?? ''),
  ]);
  return pdfFromObjects([
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${pages.map((_, index) => `${String(firstPageObject + index * 2)} 0 R`).join(' ')}]/Count ${String(pages.length)}>>`,
    '<</Type/Font/Subtype/Type0/BaseFont/Synthetic/Encoding/Identity-H/DescendantFonts[4 0 R]/ToUnicode 6 0 R>>',
    '<</Type/Font/Subtype/CIDFontType2/BaseFont/Synthetic/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/FontDescriptor 5 0 R/DW 600/CIDToGIDMap/Identity>>',
    '<</Type/FontDescriptor/FontName/Synthetic/Flags 4/FontBBox[0 -200 1000 800]/ItalicAngle 0/Ascent 800/Descent -200/CapHeight 700/StemV 80>>',
    stream('', toUnicode),
    ...pageObjects,
    // An unused object, to make a file of a chosen size that is still a well-formed PDF.
    ...(paddingBytes > 0 ? [stream('', 'x'.repeat(paddingBytes))] : []),
  ]);
}

export function unicodeTextPdf(lines: readonly string[]): Buffer {
  return unicodeTextPdfPages([lines]);
}

/**
 * A one-page PDF in a font that is not embedded and names one of Adobe's CJK character collections, the way
 * many Japanese, Chinese and Korean PDFs are made. Its text cannot be extracted without poppler-data.
 */
export function cjkCollectionPdf({
  ordering,
  encoding,
  lines,
}: {
  ordering: 'Japan1' | 'GB1' | 'Korea1';
  /** A predefined UCS2 CMap that matches the ordering. */
  encoding: 'UniJIS-UCS2-H' | 'UniGB-UCS2-H' | 'UniKS-UCS2-H';
  lines: readonly string[];
}): Buffer {
  const content = lines
    .map((line, index) => `BT /F1 16 Tf 72 ${String(720 - index * 28)} Td <${utf16Hex(line)}> Tj ET`)
    .join('\n');
  return pdfFromObjects([
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    stream('', content),
    `<</Type/Font/Subtype/Type0/BaseFont/Synthetic/Encoding/${encoding}/DescendantFonts[6 0 R]>>`,
    `<</Type/Font/Subtype/CIDFontType0/BaseFont/Synthetic/CIDSystemInfo<</Registry(Adobe)/Ordering(${ordering})/Supplement 2>>/FontDescriptor 7 0 R/DW 1000>>`,
    '<</Type/FontDescriptor/FontName/Synthetic/Flags 4/FontBBox[0 -200 1000 800]/ItalicAngle 0/Ascent 800/Descent -200/CapHeight 700/StemV 80>>',
  ]);
}
