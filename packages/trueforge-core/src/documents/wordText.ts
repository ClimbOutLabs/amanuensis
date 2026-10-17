/**
 * Reads the text of a .docx or .odt inside the sandbox with nothing but Python's standard library, so it runs
 * the same in every sandbox image. The file never reaches a parser in the server process.
 */

/** Most bytes a Word file may unpack to, so a small zip cannot fill the sandbox's memory. */
const MAX_UNPACKED_WORD_BYTES = 100 * 1024 * 1024;

const MAX_ZIP_ENTRIES = 5000;

/**
 * Run as `python3 -I -c SCRIPT path max_chars marker`; prints `marker` + `OK` and the text, or `marker` + `ERR:reason`.
 * Every failure while reading is turned into a fixed reason code, so a parser's own message, which can quote text
 * from the file, never leaves the sandbox.
 */
export const WORD_TEXT_SCRIPT = `
import sys, zipfile
from xml.etree import ElementTree as ET
path, limit, mark = sys.argv[1], int(sys.argv[2]), sys.argv[3]
sys.stdout.reconfigure(encoding='utf-8')
def fail(reason):
    print(mark + 'ERR:' + reason)
    sys.exit(0)
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
MC = '{http://schemas.openxmlformats.org/markup-compatibility/2006}'
T = '{urn:oasis:names:tc:opendocument:xmlns:text:1.0}'
def parse_xml(data):
    text = data.decode('utf-8-sig')
    lowered = text.lower()
    if '<!doctype' in lowered or '<!entity' in lowered:
        fail('UNREADABLE')
    return ET.fromstring(text)
def run_text(el, parts):
    for child in el:
        tag = child.tag
        if tag in (W + 'del', W + 'moveFrom'):
            continue
        if tag == W + 't':
            parts.append(child.text or '')
        elif tag == W + 'tab':
            parts.append('\\t')
        elif tag in (W + 'br', W + 'cr'):
            parts.append('\\n')
        elif tag == W + 'noBreakHyphen':
            parts.append('-')
        elif tag == W + 'p':
            parts.append('\\n')
            run_text(child, parts)
        elif tag == MC + 'AlternateContent':
            choice = child.find(MC + 'Choice')
            run_text(choice if choice is not None else child, parts)
        else:
            run_text(child, parts)
def paragraph_text(p):
    parts = []
    run_text(p, parts)
    return ''.join(parts)
def blocks(el, lines):
    for child in el:
        tag = child.tag
        if tag == W + 'p':
            lines.append(paragraph_text(child))
        elif tag == W + 'tbl':
            table(child, lines)
        elif tag == W + 'sdt':
            content = child.find(W + 'sdtContent')
            if content is not None:
                blocks(content, lines)
        elif tag in (W + 'ins', W + 'moveTo', W + 'customXml'):
            blocks(child, lines)
def table(tbl, lines):
    for row in tbl.findall(W + 'tr'):
        cells = []
        for cell in row.findall(W + 'tc'):
            inner = []
            blocks(cell, inner)
            cells.append(' / '.join(line.strip() for line in inner if line.strip()))
        lines.append(' | '.join(cells))
def odf_text(el):
    parts = [el.text or '']
    for child in el:
        if child.tag == T + 's':
            parts.append(' ' * min(int(child.get(T + 'c', '1')), 1000))
        elif child.tag == T + 'tab':
            parts.append('\\t')
        elif child.tag == T + 'line-break':
            parts.append('\\n')
        else:
            parts.append(odf_text(child))
        parts.append(child.tail or '')
    return ''.join(parts)
def read():
    with open(path, 'rb') as handle:
        if handle.read(8) == b'\\xd0\\xcf\\x11\\xe0\\xa1\\xb1\\x1a\\xe1':
            fail('OLD_OR_PROTECTED')
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        fail('NOT_ZIP')
    entries = z.infolist()
    if len(entries) > ${String(MAX_ZIP_ENTRIES)} or sum(e.file_size for e in entries) > ${String(MAX_UNPACKED_WORD_BYTES)}:
        fail('TOO_BIG')
    names = set(z.namelist())
    lines = []
    if 'word/document.xml' in names:
        body = parse_xml(z.read('word/document.xml')).find(W + 'body')
        if body is not None:
            blocks(body, lines)
    elif 'content.xml' in names:
        for el in parse_xml(z.read('content.xml')).iter():
            if el.tag in (T + 'h', T + 'p'):
                lines.append(odf_text(el))
    else:
        fail('NOT_TEXT_DOCUMENT')
    print(mark + 'OK')
    print('\\n'.join(lines)[:limit])
try:
    read()
except MemoryError:
    fail('TOO_BIG')
except Exception:
    fail('UNREADABLE')
`;

export const UNREADABLE_MESSAGE = "Aman couldn't read this file. It may be damaged. Ask the sender to send it again.";

export const WORD_PROBLEMS = {
  NOT_ZIP: 'The file is damaged or incomplete. Ask the sender to send it again.',
  NOT_TEXT_DOCUMENT: 'The file is not a Word or OpenDocument text document.',
  TOO_BIG: 'The file is too large to read.',
  OLD_OR_PROTECTED:
    'The file is protected with a password or saved in an older Word format. Open it in Word, save it as a .docx without a password, and send it again.',
  UNREADABLE: UNREADABLE_MESSAGE,
} satisfies Record<string, string>;

/** The document text from the script's output, or the plain reason it could not be read. */
export function parseWordTextOutput(input: { output: string; marker: string }): string {
  const after = input.output.split(input.marker)[1];
  if (after === undefined) {
    throw new Error('The Word reader gave no answer.');
  }
  if (after.startsWith('ERR:')) {
    const code = after.slice(4).split('\n')[0]?.trim() ?? '';
    throw new Error(Object.entries(WORD_PROBLEMS).find(([key]) => key === code)?.[1] ?? UNREADABLE_MESSAGE);
  }
  return after.slice(after.indexOf('\n') + 1);
}

/** Characters of a Word file shown as one page, about what a printed page holds. */
const WORD_PAGE_CHARS = 3000;

/** The text cut into pages of whole lines, so page_start and page_end work on a Word file as they do on a PDF. */
export function splitWordPages(text: string): string[] {
  const pages: string[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = (): void => {
    if (current.length > 0) {
      pages.push(current.join('\n'));
      current = [];
      size = 0;
    }
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    let rest = line;
    while (rest.length > WORD_PAGE_CHARS) {
      // Never cut between the two halves of a character outside the basic plane.
      const cutAt = /[\ud800-\udbff]/.test(rest.charAt(WORD_PAGE_CHARS - 1)) ? WORD_PAGE_CHARS - 1 : WORD_PAGE_CHARS;
      flush();
      pages.push(rest.slice(0, cutAt));
      rest = rest.slice(cutAt);
    }
    if (size + rest.length + 1 > WORD_PAGE_CHARS) {
      flush();
    }
    current.push(rest);
    size += rest.length + 1;
  }
  flush();
  return pages.filter(page => page.trim().length > 0);
}
