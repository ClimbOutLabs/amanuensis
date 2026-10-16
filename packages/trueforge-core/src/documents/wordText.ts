/**
 * Reads the text of a .docx or .odt inside the sandbox with python-docx and lxml, which the guest image already
 * carries (pinned by hash). The file never reaches a parser in the server process.
 */

/** Most bytes a Word file may unpack to, so a small zip cannot fill the sandbox's memory. */
export const MAX_UNPACKED_WORD_BYTES = 100 * 1024 * 1024;

const MAX_ZIP_ENTRIES = 5000;

/** Run as `python3 -I -c SCRIPT path max_chars marker`; prints `marker` + `OK` and the text, or `marker` + `ERR:reason`. */
export const WORD_TEXT_SCRIPT = `
import sys, zipfile
path, limit, mark = sys.argv[1], int(sys.argv[2]), sys.argv[3]
sys.stdout.reconfigure(encoding='utf-8')
def fail(reason):
    print(mark + 'ERR:' + reason)
    sys.exit(0)
try:
    z = zipfile.ZipFile(path)
except Exception:
    fail('NOT_ZIP')
entries = z.infolist()
if len(entries) > ${String(MAX_ZIP_ENTRIES)} or sum(e.file_size for e in entries) > ${String(MAX_UNPACKED_WORD_BYTES)}:
    fail('TOO_BIG')
names = set(z.namelist())
lines = []
if 'word/document.xml' in names:
    import docx
    from docx.table import Table
    document = docx.Document(path)
    for block in document.iter_inner_content():
        if isinstance(block, Table):
            for row in block.rows:
                seen, cells = set(), []
                for cell in row.cells:
                    if id(cell._tc) not in seen:
                        seen.add(id(cell._tc))
                        cells.append(cell.text.strip())
                lines.append(' | '.join(cells))
        else:
            lines.append(block.text)
elif 'content.xml' in names:
    from lxml import etree
    T = '{urn:oasis:names:tc:opendocument:xmlns:text:1.0}'
    root = etree.fromstring(z.read('content.xml'), etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False))
    def text_of(el):
        parts = [el.text or '']
        for child in el:
            if child.tag == T + 's':
                parts.append(' ' * min(int(child.get(T + 'c', '1')), 1000))
            elif child.tag == T + 'tab':
                parts.append('\\t')
            elif child.tag == T + 'line-break':
                parts.append('\\n')
            else:
                parts.append(text_of(child))
            parts.append(child.tail or '')
        return ''.join(parts)
    for el in root.iter(T + 'h', T + 'p'):
        lines.append(text_of(el))
else:
    fail('NOT_TEXT_DOCUMENT')
print(mark + 'OK')
print('\\n'.join(lines)[:limit])
`;

const WORD_PROBLEMS: Record<string, string> = {
  NOT_ZIP: 'The file is not a valid Word or OpenDocument text file.',
  NOT_TEXT_DOCUMENT: 'The file is not a Word or OpenDocument text document.',
  TOO_BIG: 'The document is too large once unpacked, so it was not read.',
};

/** The document text from the script's output, or the plain reason it could not be read. */
export function parseWordTextOutput(input: { output: string; marker: string }): string {
  const after = input.output.split(input.marker)[1];
  if (after === undefined) {
    throw new Error('The Word reader gave no answer.');
  }
  if (after.startsWith('ERR:')) {
    const code = after.slice(4).split('\n')[0]?.trim() ?? '';
    throw new Error(WORD_PROBLEMS[code] ?? 'The document could not be read.');
  }
  return after.slice(after.indexOf('\n') + 1);
}
