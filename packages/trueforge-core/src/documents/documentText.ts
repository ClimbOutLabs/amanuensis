/**
 * Reads the text of office documents, e-mails, web pages and plain-text files inside the sandbox with nothing but
 * Python's standard library, so it runs the same in every sandbox image and no file reaches a parser in the server.
 *
 * Formats: Word (.docx, .docm, .dotx, .doc), OpenDocument (.odt, .ods, .odp), RTF, Excel (.xlsx, .xlsm, .xls),
 * CSV and TSV, PowerPoint (.pptx, .pptm, .ppsx), HTML, e-mail (.eml, .msg, with the text of their attachments),
 * and plain text (.txt, .md, .json, .xml, .ics, .vcf, .log, .yaml). The reader looks at the bytes, not the name,
 * so a spreadsheet saved as HTML or a Word file saved as RTF is still read for what it is.
 */

/** Most bytes a zip-based document may unpack to, so a small zip cannot fill the sandbox's memory. */
export const MAX_UNPACKED_DOCUMENT_BYTES = 100 * 1024 * 1024;

/** Most entries a zip-based document may hold. */
export const MAX_ZIP_ENTRIES = 5000;

/** Extensions read by {@link DOCUMENT_TEXT_SCRIPT}. */
export const TEXT_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.doc',
  '.docx',
  '.docm',
  '.dotx',
  '.odt',
  '.rtf',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.ods',
  '.csv',
  '.tsv',
  '.ppsx',
  '.pptx',
  '.pptm',
  '.odp',
  '.html',
  '.htm',
  '.xhtml',
  '.eml',
  '.msg',
  '.txt',
  '.text',
  '.md',
  '.markdown',
  '.json',
  '.xml',
  '.ics',
  '.vcf',
  '.log',
  '.yaml',
  '.yml',
]);

/**
 * Run as `python3 -I -S -c SCRIPT path extension max_chars marker max_unpacked_bytes max_zip_entries`. Prints
 * `marker` + `OK` (or `OK TRUNCATED` when the text ran past max_chars) and the text, or `marker` + `ERR:CODE`.
 * Every failure while reading becomes a fixed code, so a parser's own message, which can quote the file, never
 * leaves the sandbox. Kept free of backticks and template placeholders so it can sit in a raw template literal.
 */
export const DOCUMENT_TEXT_SCRIPT = String.raw`
import sys, io, re, csv, zipfile, struct, datetime, email
from email import policy
from html.parser import HTMLParser
from xml.etree import ElementTree as ET

path, hint, limit, mark, max_unpacked, max_entries = (
    sys.argv[1], sys.argv[2].lower(), int(sys.argv[3]), sys.argv[4], int(sys.argv[5]), int(sys.argv[6]))
sys.stdout.reconfigure(encoding='utf-8')
MAX_DEPTH = 3


class Problem(Exception):
    pass


class Full(Exception):
    pass


class Out:
    def __init__(self):
        self.lines = []
        self.size = 0

    def line(self, text):
        text = text.rstrip()
        self.lines.append(text)
        self.size += len(text) + 1
        if self.size > limit:
            raise Full()


def u16(b, o):
    return struct.unpack_from('<H', b, o)[0]


def u32(b, o):
    return struct.unpack_from('<I', b, o)[0]


# ---------- plain text ----------

def decode_text(data):
    for bom, codec in ((b'\xef\xbb\xbf', 'utf-8'), (b'\xff\xfe\x00\x00', 'utf-32-le'), (b'\x00\x00\xfe\xff', 'utf-32-be'),
                       (b'\xff\xfe', 'utf-16-le'), (b'\xfe\xff', 'utf-16-be')):
        if data.startswith(bom):
            return data[len(bom):].decode(codec, 'replace')
    sample = data[:4096]
    if len(sample) >= 4 and sample[1::2].count(0) > len(sample) // 4 and sample[0::2].count(0) < len(sample) // 16:
        return data.decode('utf-16-le', 'replace')
    if len(sample) >= 4 and sample[0::2].count(0) > len(sample) // 4 and sample[1::2].count(0) < len(sample) // 16:
        return data.decode('utf-16-be', 'replace')
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return data.decode('cp1252', 'replace')


CONTROL = re.compile('[\x00-\x08\x0e-\x1f\x7f]')


def plain_lines(text, out):
    if len(CONTROL.findall(text[:20000])) > len(text[:20000]) // 10:
        raise Problem('NOT_SUPPORTED')
    for line in text.replace('\r\n', '\n').replace('\r', '\n').split('\n'):
        out.line(CONTROL.sub('', line))


def read_csv(data, out, tab):
    text = decode_text(data)
    if len(CONTROL.findall(text[:20000])) > len(text[:20000]) // 10:
        raise Problem('NOT_SUPPORTED')
    delimiter = '\t' if tab else ','
    if not tab:
        try:
            delimiter = csv.Sniffer().sniff(text[:8192], delimiters=',;\t|').delimiter
        except csv.Error:
            pass
    csv.field_size_limit(limit)
    for row in csv.reader(io.StringIO(text, newline=''), delimiter=delimiter):
        cells = [cell.replace('\r', ' ').replace('\n', ' ').strip() for cell in row]
        while cells and cells[-1] == '':
            cells.pop()
        if cells:
            out.line(' | '.join(cells))


# ---------- XML helpers ----------

def safe_xml(data):
    """Refuses any document type declaration, which is the only way an XML file can define entities."""
    head = data[:1 << 20]
    if head.startswith(b'\xff\xfe') or head.startswith(b'\xfe\xff'):
        head = head.decode('utf-16', 'ignore')
    else:
        head = head.decode('utf-8', 'ignore').lstrip('\ufeff')
    i = 0
    while True:
        while i < len(head) and head[i] in ' \t\r\n':
            i += 1
        if head.startswith('<?', i):
            end = head.find('?>', i)
        elif head.startswith('<!--', i):
            end = head.find('-->', i)
        elif head.startswith('<', i) and not head.startswith('<!', i):
            return data
        else:
            raise Problem('UNREADABLE')
        if end < 0:
            raise Problem('UNREADABLE')
        i = end + 2


def parse_xml(data):
    return ET.fromstring(safe_xml(data))


def iter_xml(data, events=('start', 'end')):
    return ET.iterparse(io.BytesIO(safe_xml(data)), events=events)


def open_zip(data):
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise Problem('DAMAGED')
    entries = z.infolist()
    if len(entries) > max_entries or sum(e.file_size for e in entries) > max_unpacked:
        raise Problem('TOO_BIG')
    if any(e.flag_bits & 1 for e in entries):
        raise Problem('PROTECTED')
    return z


def zip_read(z, name):
    try:
        return z.read(name)
    except KeyError:
        return None
    except (zipfile.BadZipFile, EOFError, OSError, ValueError):
        raise Problem('DAMAGED')


def rels(z, rels_name, base):
    """Maps relationship ids to (type, part name) from a .rels part."""
    data = zip_read(z, rels_name)
    found = {}
    if data is None:
        return found
    for el in parse_xml(data):
        target = el.get('Target', '')
        if el.get('TargetMode') == 'External':
            continue
        name = target.lstrip('/') if target.startswith('/') else normalize(base + target)
        found[el.get('Id')] = (el.get('Type', ''), name)
    return found


def normalize(name):
    parts = []
    for part in name.split('/'):
        if part == '..':
            if parts:
                parts.pop()
        elif part not in ('', '.'):
            parts.append(part)
    return '/'.join(parts)


# ---------- Word (.docx) ----------

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
MC = '{http://schemas.openxmlformats.org/markup-compatibility/2006}'


def w_run_text(el, parts):
    for child in el:
        tag = child.tag
        if tag in (W + 'del', W + 'moveFrom', W + 'instrText', W + 'delText'):
            continue
        if tag == W + 't':
            parts.append(child.text or '')
        elif tag == W + 'tab':
            parts.append('\t')
        elif tag in (W + 'br', W + 'cr'):
            parts.append('\n')
        elif tag == W + 'noBreakHyphen':
            parts.append('-')
        elif tag == W + 'p':
            parts.append('\n')
            w_run_text(child, parts)
        elif tag == MC + 'AlternateContent':
            choice = child.find(MC + 'Choice')
            w_run_text(choice if choice is not None else child, parts)
        else:
            w_run_text(child, parts)


def w_blocks(el, lines):
    for child in el:
        tag = child.tag
        if tag == W + 'p':
            parts = []
            w_run_text(child, parts)
            lines.append(''.join(parts))
        elif tag == W + 'tbl':
            for row in child.findall(W + 'tr'):
                cells = []
                for cell in row.findall(W + 'tc'):
                    inner = []
                    w_blocks(cell, inner)
                    cells.append(' / '.join(line.strip() for line in inner if line.strip()))
                lines.append(' | '.join(cells))
        elif tag == W + 'sdt':
            content = child.find(W + 'sdtContent')
            if content is not None:
                w_blocks(content, lines)
        elif tag in (W + 'ins', W + 'moveTo', W + 'customXml', W + 'footnote', W + 'endnote', W + 'comment'):
            w_blocks(child, lines)


def read_docx(z, out):
    names = set(z.namelist())
    main = 'word/document.xml'
    for rel_type, name in rels(z, '_rels/.rels', '').values():
        if rel_type.endswith('/officeDocument') and name in names:
            main = name
    data = zip_read(z, main)
    if data is None:
        raise Problem('DAMAGED')
    body = parse_xml(data).find(W + 'body')
    lines = []
    if body is not None:
        w_blocks(body, lines)
    for line in lines:
        out.line(line)
    for part, title, tag in (('word/footnotes.xml', 'Footnotes:', 'footnote'), ('word/endnotes.xml', 'Endnotes:', 'endnote'),
                             ('word/comments.xml', 'Comments:', 'comment')):
        data = zip_read(z, part)
        if data is None:
            continue
        notes = []
        for note in parse_xml(data).findall(W + tag):
            if note.get(W + 'type') in ('separator', 'continuationSeparator', 'continuationNotice'):
                continue
            inner = []
            w_blocks(note, inner)
            text = ' '.join(line.strip() for line in inner if line.strip())
            if text:
                author = note.get(W + 'author')
                notes.append(author + ': ' + text if tag == 'comment' and author else text)
        if notes:
            out.line('')
            out.line(title)
            for note in notes:
                out.line(note)


# ---------- spreadsheet values ----------

DATE_FORMAT_IDS = set(range(14, 23)) | set(range(27, 37)) | set(range(45, 48)) | set(range(50, 59))


def is_date_format(fmt_id, fmt_code):
    if fmt_id in DATE_FORMAT_IDS:
        return True
    if not fmt_code:
        return False
    code = re.sub(r'"[^"]*"|\[[^\]]*\]|\\.|_.|\*.', '', fmt_code)
    return bool(re.search('[dmyhs]', code, re.I)) and not re.search('general', code, re.I)


def number_text(value):
    if value != value or value in (float('inf'), float('-inf')):
        return str(value)
    if value == int(value) and abs(value) < 1e15:
        return str(int(value))
    return format(value, '.15g')


def date_text(value, epoch1904):
    try:
        base = datetime.datetime(1904, 1, 1) if epoch1904 else datetime.datetime(1899, 12, 30)
        moment = base + datetime.timedelta(days=value)
        moment = moment.replace(microsecond=0) + datetime.timedelta(seconds=round(moment.microsecond / 1e6))
    except (OverflowError, ValueError):
        return number_text(value)
    if value < 1 and not epoch1904:
        return moment.strftime('%H:%M:%S' if moment.second else '%H:%M')
    if moment.hour == 0 and moment.minute == 0 and moment.second == 0:
        return moment.strftime('%Y-%m-%d')
    return moment.strftime('%Y-%m-%d %H:%M:%S' if moment.second else '%Y-%m-%d %H:%M')


def emit_rows(rows, out):
    for _, cells in sorted(rows.items()):
        if not cells:
            continue
        width = max(cells) + 1
        values = [cells.get(i, '') for i in range(width)]
        if any(value.strip() for value in values):
            out.line(' | '.join(value.replace('\r', ' ').replace('\n', ' ').strip() for value in values))


def column_index(ref):
    n = 0
    for ch in ref:
        if 'A' <= ch <= 'Z':
            n = n * 26 + ord(ch) - 64
        else:
            break
    return n - 1


# ---------- Excel (.xlsx) ----------

S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


def xlsx_text(el):
    """The text of a shared or inline string, leaving out phonetic guides."""
    if el is None:
        return ''
    parts = []
    for child in el:
        if child.tag == S + 't':
            parts.append(child.text or '')
        elif child.tag == S + 'r':
            parts.extend(t.text or '' for t in child.findall(S + 't'))
    return ''.join(parts)


def read_xlsx(z, out):
    workbook_name = 'xl/workbook.xml'
    for rel_type, name in rels(z, '_rels/.rels', '').values():
        if rel_type.endswith('/officeDocument'):
            workbook_name = name
    base = workbook_name.rsplit('/', 1)[0] + '/'
    data = zip_read(z, workbook_name)
    if data is None:
        raise Problem('DAMAGED')
    workbook = parse_xml(data)
    pr = workbook.find(S + 'workbookPr')
    epoch1904 = pr is not None and pr.get('date1904') in ('1', 'true')
    links = rels(z, base + '_rels/' + workbook_name.rsplit('/', 1)[-1] + '.rels', base)
    strings, styles = [], []
    for rel_type, name in links.values():
        if rel_type.endswith('/sharedStrings'):
            for event, el in iter_xml(zip_read(z, name) or b'<sst/>', ('end',)):
                if el.tag == S + 'si':
                    strings.append(xlsx_text(el))
                    el.clear()
        elif rel_type.endswith('/styles'):
            root = parse_xml(zip_read(z, name) or b'<styleSheet/>')
            codes = {int(f.get('numFmtId', '0')): f.get('formatCode', '') for f in root.iter(S + 'numFmt')}
            xfs = root.find(S + 'cellXfs')
            if xfs is not None:
                for xf in xfs.findall(S + 'xf'):
                    fmt_id = int(xf.get('numFmtId', '0'))
                    styles.append(is_date_format(fmt_id, codes.get(fmt_id)))
    sheets = workbook.find(S + 'sheets')
    first = True
    for sheet in (sheets if sheets is not None else []):
        target = links.get(sheet.get(R + 'id'))
        if target is None or not target[0].endswith('/worksheet'):
            continue
        data = zip_read(z, target[1])
        if data is None:
            continue
        if not first:
            out.line('')
        first = False
        hidden = ' (hidden)' if sheet.get('state') in ('hidden', 'veryHidden') else ''
        out.line('Sheet: ' + sheet.get('name', '') + hidden)
        rows, row_number, size, cut = {}, 0, 0, False
        for event, el in iter_xml(data):
            if event == 'start' and el.tag == S + 'row':
                row_number = int(el.get('r', row_number + 1))
            elif event == 'end' and el.tag == S + 'c':
                kind = el.get('t', 'n')
                value = el.find(S + 'v')
                raw = value.text if value is not None and value.text is not None else ''
                if kind == 's':
                    text = strings[int(raw)] if raw.isdigit() and int(raw) < len(strings) else ''
                elif kind == 'inlineStr':
                    text = xlsx_text(el.find(S + 'is'))
                elif kind == 'b':
                    text = 'TRUE' if raw == '1' else 'FALSE' if raw else ''
                elif kind in ('str', 'e', 'd'):
                    text = raw
                elif raw:
                    try:
                        number = float(raw)
                        style = int(el.get('s', '0'))
                        text = date_text(number, epoch1904) if style < len(styles) and styles[style] else number_text(number)
                    except ValueError:
                        text = raw
                else:
                    formula = el.find(S + 'f')
                    text = '=' + formula.text if formula is not None and formula.text else ''
                if text:
                    ref = el.get('r', '')
                    column = column_index(ref) if ref else len(rows.get(row_number, {}))
                    if 0 <= column < 16384:
                        rows.setdefault(row_number, {})[column] = text
                        size += len(text) + 3
                el.clear()
                if size > limit:
                    cut = True
                    break
            elif event == 'end' and el.tag == S + 'row':
                el.clear()
        emit_rows(rows, out)
        if cut:
            raise Full()


# ---------- PowerPoint (.pptx) ----------

A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
SKIP_PLACEHOLDERS = ('sldNum', 'dt', 'ftr', 'hdr', 'sldImg')


def a_paragraph(p):
    parts = []
    for el in p.iter():
        if el.tag == A + 't':
            parts.append(el.text or '')
        elif el.tag == A + 'br':
            parts.append('\n')
    return ''.join(parts)


def slide_lines(el, lines):
    for child in el:
        tag = child.tag
        if tag in (P + 'sp', P + 'graphicFrame', P + 'pic', P + 'cxnSp'):
            ph = child.find('.//' + P + 'ph')
            if ph is not None and ph.get('type') in SKIP_PLACEHOLDERS:
                continue
        if tag == A + 'tbl':
            for row in child.findall(A + 'tr'):
                cells = []
                for cell in row.findall(A + 'tc'):
                    cells.append(' / '.join(a_paragraph(p).strip() for p in cell.iter(A + 'p') if a_paragraph(p).strip()))
                lines.append(' | '.join(cells))
        elif tag == A + 'p':
            lines.append(a_paragraph(child))
        else:
            slide_lines(child, lines)


def read_pptx(z, out):
    main = 'ppt/presentation.xml'
    for rel_type, name in rels(z, '_rels/.rels', '').values():
        if rel_type.endswith('/officeDocument'):
            main = name
    base = main.rsplit('/', 1)[0] + '/'
    data = zip_read(z, main)
    if data is None:
        raise Problem('DAMAGED')
    links = rels(z, base + '_rels/' + main.rsplit('/', 1)[-1] + '.rels', base)
    ids = parse_xml(data).find(P + 'sldIdLst')
    number = 0
    for sld in (ids if ids is not None else []):
        target = links.get(sld.get(R + 'id'))
        if target is None:
            continue
        slide_data = zip_read(z, target[1])
        if slide_data is None:
            continue
        number += 1
        slide = parse_xml(slide_data)
        if number > 1:
            out.line('')
        out.line('Slide ' + str(number) + (' (hidden)' if slide.get('show') in ('0', 'false') else ''))
        lines = []
        slide_lines(slide, lines)
        for line in lines:
            out.line(line)
        slide_dir = target[1].rsplit('/', 1)[0] + '/'
        slide_rels = rels(z, slide_dir + '_rels/' + target[1].rsplit('/', 1)[-1] + '.rels', slide_dir)
        for rel_type, name in slide_rels.values():
            if rel_type.endswith('/notesSlide'):
                notes_data = zip_read(z, name)
                if notes_data is None:
                    continue
                notes = []
                slide_lines(parse_xml(notes_data), notes)
                notes = [line for line in notes if line.strip()]
                if notes:
                    out.line('Notes:')
                    for line in notes:
                        out.line(line)


# ---------- OpenDocument (.odt, .ods, .odp) ----------

OFFICE = '{urn:oasis:names:tc:opendocument:xmlns:office:1.0}'
T = '{urn:oasis:names:tc:opendocument:xmlns:text:1.0}'
TABLE = '{urn:oasis:names:tc:opendocument:xmlns:table:1.0}'
DRAW = '{urn:oasis:names:tc:opendocument:xmlns:drawing:1.0}'
PRES = '{urn:oasis:names:tc:opendocument:xmlns:presentation:1.0}'


def odf_text(el):
    parts = [el.text or '']
    for child in el:
        if child.tag == T + 's':
            parts.append(' ' * min(int(child.get(T + 'c', '1') or 1), 1000))
        elif child.tag == T + 'tab':
            parts.append('\t')
        elif child.tag == T + 'line-break':
            parts.append('\n')
        elif child.tag in (T + 'note', OFFICE + 'annotation'):
            pass
        else:
            parts.append(odf_text(child))
        parts.append(child.tail or '')
    return ''.join(parts)


def odf_blocks(el, lines):
    for child in el:
        tag = child.tag
        if tag in (T + 'h', T + 'p'):
            lines.append(odf_text(child))
            for note in child.iter(T + 'note-body'):
                inner = []
                odf_blocks(note, inner)
                lines.extend(inner)
        elif tag == TABLE + 'table':
            for row in child.iter(TABLE + 'table-row'):
                cells = []
                for cell in row:
                    if cell.tag in (TABLE + 'table-cell', TABLE + 'covered-table-cell'):
                        inner = []
                        odf_blocks(cell, inner)
                        cells.append(' / '.join(line.strip() for line in inner if line.strip()))
                while cells and cells[-1] == '':
                    cells.pop()
                if cells:
                    lines.append(' | '.join(cells))
        elif tag in (OFFICE + 'annotation', T + 'tracked-changes'):
            continue
        elif tag == DRAW + 'frame' and child.get(PRES + 'class') in ('page-number', 'date-time', 'footer', 'header', 'page'):
            continue
        else:
            odf_blocks(child, lines)


def read_ods_table(table, out):
    for row in table.iter(TABLE + 'table-row'):
        cells, pending = [], 0
        for cell in row:
            if cell.tag not in (TABLE + 'table-cell', TABLE + 'covered-table-cell'):
                continue
            repeat = int(cell.get(TABLE + 'number-columns-repeated', '1') or 1)
            text = '\n'.join(odf_text(p) for p in cell.findall(T + 'p')).strip()
            if not text:
                pending += repeat
                continue
            if len(cells) + pending > 16384:
                break
            cells.extend([''] * pending)
            pending = 0
            cells.extend([text] * min(repeat, 16384 - len(cells)))
        if not cells:
            continue
        line = ' | '.join(cell.replace('\n', ' ') for cell in cells)
        for _ in range(min(int(row.get(TABLE + 'number-rows-repeated', '1') or 1), 1000)):
            out.line(line)


def read_odf(z, out):
    data = zip_read(z, 'content.xml')
    if data is None:
        raise Problem('NOT_SUPPORTED')
    body = parse_xml(data).find(OFFICE + 'body')
    if body is None:
        raise Problem('DAMAGED')
    text, sheet, show = body.find(OFFICE + 'text'), body.find(OFFICE + 'spreadsheet'), body.find(OFFICE + 'presentation')
    if text is not None:
        lines = []
        odf_blocks(text, lines)
        for line in lines:
            out.line(line)
    elif sheet is not None:
        for index, table in enumerate(sheet.findall(TABLE + 'table')):
            if index:
                out.line('')
            out.line('Sheet: ' + table.get(TABLE + 'name', ''))
            read_ods_table(table, out)
    elif show is not None:
        for index, page in enumerate(show.findall(DRAW + 'page')):
            if index:
                out.line('')
            out.line('Slide ' + str(index + 1))
            notes = page.find(PRES + 'notes')
            if notes is not None:
                page.remove(notes)
            lines = []
            odf_blocks(page, lines)
            for line in lines:
                out.line(line)
            if notes is not None:
                inner = []
                odf_blocks(notes, inner)
                inner = [line for line in inner if line.strip()]
                if inner:
                    out.line('Notes:')
                    for line in inner:
                        out.line(line)
    else:
        raise Problem('NOT_SUPPORTED')


def read_zip(data, out):
    z = open_zip(data)
    names = set(z.namelist())
    if 'EncryptedPackage' in names:
        raise Problem('PROTECTED')
    if 'word/document.xml' in names or any(n.startswith('word/') and n.endswith('.xml') for n in names):
        read_docx(z, out)
    elif any(n.startswith('xl/') for n in names):
        read_xlsx(z, out)
    elif any(n.startswith('ppt/') for n in names):
        read_pptx(z, out)
    elif 'content.xml' in names:
        read_odf(z, out)
    else:
        raise Problem('NOT_SUPPORTED')


# ---------- RTF ----------

RTF_TOKEN = re.compile(r"\\([a-zA-Z]{1,32})(-?\d{1,10})? ?|\\'([0-9a-fA-F]{2})|\\([^a-zA-Z])|([{}])|[\r\n]+|([^\\{}\r\n]+)")
RTF_SKIP = {
    'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'objdata', 'header', 'headerl', 'headerr', 'headerf',
    'footer', 'footerl', 'footerr', 'footerf', 'fldinst', 'datastore', 'themedata', 'colorschememapping',
    'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'filetbl', 'revtbl',
    'pgdsctbl', 'nonshppict', 'bkmkstart', 'bkmkend', 'xe', 'tc', 'private', 'datafield', 'operator', 'author',
    'title', 'subject', 'keywords', 'comment', 'doccomm', 'company', 'userprops', 'mmathPr', 'listtext',
    'fchars', 'lchars', 'shpinst', 'sp', 'template', 'atnauthor', 'atnid', 'atrfstart', 'atrfend', 'ftnsep',
    'ftnsepc', 'aftnsep', 'aftnsepc', 'protusertbl', 'defchp', 'defpap', 'wgrffmtfilter', 'mhtmltag',
}
RTF_SPECIAL = {
    'par': '\n', 'line': '\n', 'sect': '\n', 'page': '\n', 'tab': '\t', 'cell': ' | ', 'nestcell': ' | ',
    'row': '\n', 'nestrow': '\n', 'emdash': '\u2014', 'endash': '\u2013', 'bullet': '\u2022', 'lquote': '\u2018',
    'rquote': '\u2019', 'ldblquote': '\u201c', 'rdblquote': '\u201d', 'emspace': ' ', 'enspace': ' ', 'qmspace': ' ',
}
RTF_CHARSETS = {128: 'cp932', 129: 'cp949', 134: 'gbk', 136: 'big5', 161: 'cp1253', 162: 'cp1254', 163: 'cp1258',
                177: 'cp1255', 178: 'cp1256', 186: 'cp1257', 204: 'cp1251', 222: 'cp874', 238: 'cp1250'}


def read_rtf(data, out):
    text = data.decode('latin-1')
    state = {'skip': False, 'uc': 1, 'codec': None, 'fonttbl': False}
    stack = []
    codepage = 'cp1252'
    fonts = {}
    defining = None
    pending = 0
    star = False
    parts = []
    raw = bytearray()

    def flush():
        if raw:
            for codec in (state['codec'], codepage, 'cp1252'):
                if codec:
                    try:
                        parts.append(bytes(raw).decode(codec, 'replace'))
                        break
                    except LookupError:
                        continue
            raw.clear()

    pos = 0
    while pos < len(text):
        m = RTF_TOKEN.match(text, pos)
        if m is None:
            pos += 1
            continue
        pos = m.end()
        word, arg, hexcode, symbol, brace, chars = m.groups()
        if brace is not None:
            flush()
            pending = 0
            if brace == '{':
                stack.append(dict(state))
                star = False
            elif stack:
                state = stack.pop()
            continue
        if word is not None:
            if word == 'bin' and arg:
                pos += max(0, int(arg))
                continue
            if star or word in RTF_SKIP:
                star = False
                if word == 'fonttbl':
                    state['fonttbl'] = True
                state['skip'] = True
                continue
            if word == 'ansicpg' and arg:
                try:
                    ''.encode('cp' + arg)
                    codepage = 'cp' + arg
                except LookupError:
                    pass
            elif word == 'f' and arg is not None:
                if state['fonttbl']:
                    defining = arg
                elif not state['skip']:
                    flush()
                    state['codec'] = fonts.get(arg)
            elif word == 'fcharset' and arg is not None and state['fonttbl'] and defining is not None:
                fonts[defining] = RTF_CHARSETS.get(int(arg))
            elif word == 'uc' and arg is not None:
                state['uc'] = max(0, int(arg))
            elif word == 'u' and arg is not None:
                if not state['skip']:
                    flush()
                    value = int(arg)
                    parts.append(chr(value + 65536 if value < 0 else value))
                pending = state['uc']
            elif not state['skip'] and word in RTF_SPECIAL:
                flush()
                parts.append(RTF_SPECIAL[word])
            continue
        if pending:
            if chars is not None and len(chars) > 1:
                chars = chars[pending:] if pending < len(chars) else ''
                pending = max(0, pending - len(m.group(6)))
            else:
                pending -= 1
                continue
        if symbol is not None:
            if symbol == '*':
                star = True
            elif not state['skip']:
                flush()
                parts.append({'~': ' ', '-': '', '_': '-', '\\': '\\', '{': '{', '}': '}'}.get(symbol, ''))
        elif hexcode is not None:
            if not state['skip']:
                raw.append(int(hexcode, 16))
        elif chars and not state['skip']:
            flush()
            parts.append(chars)
    flush()
    joined = ''.join(parts).encode('utf-16', 'surrogatepass').decode('utf-16', 'replace')
    for line in joined.split('\n'):
        out.line(line[:-3] if line.endswith(' | ') else line)


# ---------- HTML ----------

class HtmlText(HTMLParser):
    BLOCK = {'p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'section', 'article',
             'header', 'footer', 'blockquote', 'pre', 'hr', 'ul', 'ol', 'dl', 'dt', 'dd', 'title', 'address'}
    SKIP = {'script', 'style', 'noscript', 'template', 'svg', 'head'}

    def __init__(self):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.parts = []
        self.skipping = 0
        self.title = None
        self.in_title = False
        self.pre = 0
        self.cell = 0

    def handle_starttag(self, tag, attrs):
        if tag == 'pre':
            self.pre += 1
        if tag == 'title':
            self.in_title = True
            self.title = ''
        if tag in self.SKIP:
            self.skipping += 1
        elif tag in ('td', 'th'):
            self.cell += 1
            self.parts.append(' | ')
        elif tag == 'tr':
            self.cell = 0
            self.parts.append('\n')
        elif tag in self.BLOCK:
            self.parts.append(' ' if self.cell and tag not in ('table', 'br') else '\n')
            if tag == 'li':
                self.parts.append('- ')

    def handle_startendtag(self, tag, attrs):
        if tag in ('br', 'hr'):
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag == 'pre':
            self.pre = max(0, self.pre - 1)
        if tag == 'title':
            self.in_title = False
        if tag in self.SKIP:
            self.skipping = max(0, self.skipping - 1)
        elif tag in ('td', 'th'):
            self.cell = max(0, self.cell - 1)
        elif tag == 'table':
            self.cell = 0
            self.parts.append('\n')
        elif tag in self.BLOCK:
            self.parts.append(' ' if self.cell else '\n')

    def handle_data(self, data):
        if self.in_title:
            self.title = (self.title or '') + data
        elif not self.skipping:
            self.parts.append(data if self.pre else re.sub(r'\s+', ' ', data))


def html_lines(text):
    parser = HtmlText()
    parser.feed(text)
    parser.close()
    lines = []
    title = (parser.title or '').strip()
    if title:
        lines.append(title)
    for line in ''.join(parser.parts).split('\n'):
        line = re.sub(r'[ \t\u00a0]+', ' ', line).strip()
        while line.startswith('|'):
            line = line[1:].strip()
        if line or (lines and lines[-1]):
            lines.append(line)
    return lines


def decode_html(data):
    found = re.search(rb'<meta[^>]+charset=["\']?([A-Za-z0-9_\-]+)', data[:4096], re.I)
    if found:
        try:
            return data.decode(found.group(1).decode('ascii'), 'replace')
        except LookupError:
            pass
    return decode_text(data)


def read_html(data, out):
    for line in html_lines(decode_html(data)):
        out.line(line)


# ---------- compound files (.doc, .xls, .msg) ----------

OLE = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'
END = 0xFFFFFFFA


class Cfb:
    def __init__(self, data):
        if len(data) < 512 or data[:8] != OLE:
            raise Problem('DAMAGED')
        self.data = data
        self.ssz = 1 << u16(data, 0x1E)
        self.msz = 1 << u16(data, 0x20)
        if self.ssz not in (512, 4096) or self.msz != 64:
            raise Problem('DAMAGED')
        nfat, dir_start, self.cutoff = u32(data, 0x2C), u32(data, 0x30), u32(data, 0x38)
        minifat_start, difat_start = u32(data, 0x3C), u32(data, 0x44)
        difat = list(struct.unpack_from('<109I', data, 0x4C))
        seen = set()
        sector = difat_start
        per = self.ssz // 4
        while sector < END and len(difat) < nfat + per:
            if sector in seen:
                raise Problem('DAMAGED')
            seen.add(sector)
            block = struct.unpack('<%dI' % per, self.sector(sector))
            difat.extend(block[:-1])
            sector = block[-1]
        fat_sectors = [s for s in difat if s < END][:nfat]
        self.fat = []
        for s in fat_sectors:
            self.fat.extend(struct.unpack('<%dI' % per, self.sector(s)))
        directory = self.chain(dir_start, self.fat, self.sector)
        self.entries = []
        for offset in range(0, len(directory) - 127, 128):
            e = directory[offset:offset + 128]
            name_len = u16(e, 0x40)
            name = e[:max(0, min(name_len, 64) - 2)].decode('utf-16-le', 'replace')
            size = u32(e, 0x78) if self.ssz == 512 else struct.unpack_from('<Q', e, 0x78)[0]
            self.entries.append({'name': name, 'type': e[0x42], 'left': u32(e, 0x44), 'right': u32(e, 0x48),
                                 'child': u32(e, 0x4C), 'start': u32(e, 0x74), 'size': size})
        if not self.entries or self.entries[0]['type'] != 5:
            raise Problem('DAMAGED')
        root = self.entries[0]
        self.ministream = self.chain(root['start'], self.fat, self.sector)[:root['size']]
        minifat_bytes = self.chain(minifat_start, self.fat, self.sector)
        self.minifat = list(struct.unpack('<%dI' % (len(minifat_bytes) // 4), minifat_bytes[:len(minifat_bytes) // 4 * 4]))

    def sector(self, number):
        offset = (number + 1) * self.ssz
        if offset >= len(self.data):
            raise Problem('DAMAGED')
        block = self.data[offset:offset + self.ssz]
        return block + b'\0' * (self.ssz - len(block))

    def mini_sector(self, number):
        offset = number * self.msz
        if offset >= len(self.ministream):
            raise Problem('DAMAGED')
        block = self.ministream[offset:offset + self.msz]
        return block + b'\0' * (self.msz - len(block))

    def chain(self, start, table, read):
        parts = []
        seen = set()
        sector = start
        while sector < END:
            if sector in seen or sector >= len(table):
                raise Problem('DAMAGED')
            seen.add(sector)
            parts.append(read(sector))
            sector = table[sector]
        return b''.join(parts)

    def children(self, index):
        found = {}
        stack = [self.entries[index]['child']]
        seen = set()
        while stack:
            i = stack.pop()
            if i >= len(self.entries) or i in seen:
                continue
            seen.add(i)
            e = self.entries[i]
            found[e['name']] = i
            stack.extend((e['left'], e['right']))
        return found

    def stream(self, index):
        e = self.entries[index]
        if e['type'] != 2:
            return None
        if e['size'] < self.cutoff:
            data = self.chain(e['start'], self.minifat, self.mini_sector)
        else:
            data = self.chain(e['start'], self.fat, self.sector)
        if len(data) < e['size']:
            raise Problem('DAMAGED')
        return data[:e['size']]

    def named(self, index, name):
        child = self.children(index).get(name)
        return None if child is None else self.stream(child)


def read_cfb(data, out, depth):
    cfb = Cfb(data)
    top = cfb.children(0)
    lowered = {name.lower(): name for name in top}
    if 'encryptedpackage' in lowered or 'encryptioninfo' in lowered:
        raise Problem('PROTECTED')
    if 'worddocument' in lowered:
        read_doc(cfb, top, out)
    elif 'workbook' in lowered:
        read_xls(cfb.stream(top[lowered['workbook']]), out)
    elif any(name.startswith('__substg1.0_') for name in top):
        read_msg(cfb, 0, out, depth, 32)
    elif 'book' in lowered or 'powerpoint document' in lowered:
        raise Problem('OLD_FORMAT')
    else:
        raise Problem('NOT_SUPPORTED')


# Word 97-2003 (.doc)

def read_doc(cfb, top, out):
    word = cfb.stream(top['WordDocument'])
    if word is None or len(word) < 0x200 or u16(word, 0) != 0xA5EC:
        raise Problem('DAMAGED')
    if u16(word, 2) < 0xC1:
        raise Problem('OLD_FORMAT')
    flags = u16(word, 0x0A)
    if flags & 0x0100:
        raise Problem('PROTECTED')
    table_name = '1Table' if flags & 0x0200 else '0Table'
    table = cfb.stream(top[table_name]) if table_name in top else None
    if table is None:
        raise Problem('DAMAGED')
    csw = u16(word, 32)
    lw_at = 34 + csw * 2
    cslw = u16(word, lw_at)
    lw = struct.unpack_from('<%di' % cslw, word, lw_at + 2)
    fc_at = lw_at + 2 + cslw * 4 + 2
    fc_clx, lcb_clx = struct.unpack_from('<II', word, fc_at + 33 * 8)
    clx = table[fc_clx:fc_clx + lcb_clx]
    i = 0
    pieces = None
    while i < len(clx):
        if clx[i] == 1:
            i += 3 + u16(clx, i + 1)
        elif clx[i] == 2:
            size = u32(clx, i + 1)
            plc = clx[i + 5:i + 5 + size]
            n = (len(plc) - 4) // 12
            cps = struct.unpack_from('<%dI' % (n + 1), plc, 0)
            pieces = []
            for k in range(n):
                fc = u32(plc, (n + 1) * 4 + k * 8 + 2)
                pieces.append((cps[k], cps[k + 1], fc))
            break
        else:
            raise Problem('DAMAGED')
    if pieces is None:
        raise Problem('DAMAGED')

    def text_range(start, end):
        parts = []
        for cp_start, cp_end, fc in pieces:
            lo, hi = max(start, cp_start), min(end, cp_end)
            if lo >= hi:
                continue
            if fc & 0x40000000:
                offset = (fc & 0x3FFFFFFF) // 2 + (lo - cp_start)
                parts.append(word[offset:offset + hi - lo].decode('cp1252', 'replace'))
            else:
                offset = fc + (lo - cp_start) * 2
                parts.append(word[offset:offset + (hi - lo) * 2].decode('utf-16-le', 'replace'))
        return clean_doc(''.join(parts))

    ccp_text, ccp_ftn, ccp_hdd, ccp_mcr, ccp_atn, ccp_edn, ccp_txbx = (lw[3], lw[4], lw[5], lw[6], lw[7], lw[8], lw[9])
    for line in text_range(0, ccp_text).split('\n'):
        out.line(line)
    at = ccp_text
    sections = (('Footnotes:', ccp_ftn), (None, ccp_hdd), (None, ccp_mcr), ('Comments:', ccp_atn),
                ('Endnotes:', ccp_edn), ('Text boxes:', ccp_txbx))
    for title, count in sections:
        if title is not None and count > 1:
            text = text_range(at, at + count).strip()
            if text:
                out.line('')
                out.line(title)
                for line in text.split('\n'):
                    out.line(line)
        at += max(0, count)


def clean_doc(text):
    parts = []
    fields = []
    last_cell = False
    for ch in text:
        code = ord(ch)
        if code == 0x13:
            fields.append('code')
            continue
        if code == 0x14:
            if fields:
                fields[-1] = 'result'
            continue
        if code == 0x15:
            if fields:
                fields.pop()
            continue
        if 'code' in fields:
            continue
        if code == 0x07:
            parts.append('\n' if last_cell else ' | ')
            last_cell = not last_cell
            continue
        last_cell = False
        if ch in '\r\x0b\x0c\x0e':
            parts.append('\n')
        elif code == 0x1e:
            parts.append('-')
        elif code == 0xa0:
            parts.append(' ')
        elif ch == '\t' or code >= 0x20:
            parts.append(ch)
    return '\n'.join(line[:-3] if line.endswith(' | ') else line for line in ''.join(parts).split('\n'))


# Excel 97-2003 (.xls)

XLS_ERRORS = {0x00: '#NULL!', 0x07: '#DIV/0!', 0x0F: '#VALUE!', 0x17: '#REF!', 0x1D: '#NAME?', 0x24: '#NUM!', 0x2A: '#N/A'}


class Segments:
    """An SST record and its CONTINUE records. Characters split across records restart with a new flags byte."""

    def __init__(self, segments):
        self.segments = segments
        self.i = 0
        self.p = 0

    def read(self, n):
        parts = []
        while n > 0:
            if self.i >= len(self.segments):
                raise Problem('DAMAGED')
            seg = self.segments[self.i]
            if self.p >= len(seg):
                self.i += 1
                self.p = 0
                continue
            take = seg[self.p:self.p + n]
            parts.append(take)
            n -= len(take)
            self.p += len(take)
        return b''.join(parts)

    def chars(self, count, high):
        parts = []
        while count > 0:
            if self.i >= len(self.segments):
                raise Problem('DAMAGED')
            seg = self.segments[self.i]
            if self.p >= len(seg):
                self.i += 1
                if self.i >= len(self.segments) or not self.segments[self.i]:
                    raise Problem('DAMAGED')
                high = self.segments[self.i][0] & 1
                self.p = 1
                continue
            size = 2 if high else 1
            n = min(count, (len(seg) - self.p) // size)
            if n == 0:
                raise Problem('DAMAGED')
            parts.append(seg[self.p:self.p + n * size].decode('utf-16-le' if high else 'latin-1', 'replace'))
            self.p += n * size
            count -= n
        return ''.join(parts)


def xl_string(data, offset, length_bytes=2):
    count = data[offset] if length_bytes == 1 else u16(data, offset)
    flags = data[offset + length_bytes]
    at = offset + length_bytes + 1
    if flags & 0x08:
        at += 2
    if flags & 0x04:
        at += 4
    if flags & 1:
        return data[at:at + count * 2].decode('utf-16-le', 'replace')
    return data[at:at + count].decode('latin-1', 'replace')


def xls_records(stream, start):
    pos = start
    while pos + 4 <= len(stream):
        rid, size = struct.unpack_from('<HH', stream, pos)
        yield pos, rid, stream[pos + 4:pos + 4 + size]
        pos += 4 + size


def rk_value(raw):
    if raw & 2:
        value = float(struct.unpack('<i', struct.pack('<I', raw & 0xFFFFFFFC))[0] >> 2)
    else:
        value = struct.unpack('<d', struct.pack('<Q', (raw & 0xFFFFFFFC) << 32))[0]
    return value / 100 if raw & 1 else value


def read_xls(stream, out):
    if stream is None:
        raise Problem('DAMAGED')
    records = list(xls_records(stream, 0))
    if not records or records[0][1] != 0x0809 or len(records[0][2]) < 2:
        raise Problem('DAMAGED')
    if u16(records[0][2], 0) != 0x0600:
        raise Problem('OLD_FORMAT')
    sheets, strings, formats, xfs = [], [], {}, []
    epoch1904 = False
    index = 1
    while index < len(records):
        _, rid, data = records[index]
        index += 1
        if rid == 0x000A:
            break
        if rid == 0x002F:
            raise Problem('PROTECTED')
        if rid == 0x0022 and len(data) >= 2:
            epoch1904 = u16(data, 0) == 1
        elif rid == 0x0085 and len(data) >= 8:
            sheets.append((u32(data, 0), data[4], data[5], xl_string(data, 6, 1)))
        elif rid == 0x041E and len(data) >= 5:
            formats[u16(data, 0)] = xl_string(data, 2)
        elif rid == 0x00E0 and len(data) >= 4:
            xfs.append(u16(data, 2))
        elif rid == 0x00FC and len(data) >= 8:
            segments = [data]
            while index < len(records) and records[index][1] == 0x003C:
                segments.append(records[index][2])
                index += 1
            reader = Segments(segments)
            reader.read(4)
            unique = struct.unpack('<I', reader.read(4))[0]
            for _ in range(unique):
                count = struct.unpack('<H', reader.read(2))[0]
                flags = reader.read(1)[0]
                runs = struct.unpack('<H', reader.read(2))[0] if flags & 0x08 else 0
                ext = struct.unpack('<I', reader.read(4))[0] if flags & 0x04 else 0
                strings.append(reader.chars(count, flags & 1))
                reader.read(runs * 4 + ext)
    dates = [is_date_format(fmt, formats.get(fmt)) for fmt in xfs]

    def value_text(value, xf):
        return date_text(value, epoch1904) if xf < len(dates) and dates[xf] else number_text(value)

    first = True
    for bof, state, kind, name in sheets:
        if kind != 0:
            continue
        if not first:
            out.line('')
        first = False
        out.line('Sheet: ' + name + (' (hidden)' if state & 3 else ''))
        rows, size, formula_cell, cut = {}, 0, None, False
        for _, rid, data in xls_records(stream, bof):
            cell = None
            if rid == 0x000A:
                break
            if rid == 0x00FD and len(data) >= 10:
                isst = u32(data, 6)
                cell = (u16(data, 0), u16(data, 2), strings[isst] if isst < len(strings) else '')
            elif rid in (0x0204, 0x00D6) and len(data) >= 9:
                cell = (u16(data, 0), u16(data, 2), xl_string(data, 6))
            elif rid == 0x0203 and len(data) >= 14:
                cell = (u16(data, 0), u16(data, 2), value_text(struct.unpack_from('<d', data, 6)[0], u16(data, 4)))
            elif rid == 0x027E and len(data) >= 10:
                cell = (u16(data, 0), u16(data, 2), value_text(rk_value(u32(data, 6)), u16(data, 4)))
            elif rid == 0x00BD and len(data) >= 12:
                row, col = u16(data, 0), u16(data, 2)
                for k in range((len(data) - 6) // 6):
                    xf, raw = struct.unpack_from('<HI', data, 4 + k * 6)
                    text = value_text(rk_value(raw), xf)
                    rows.setdefault(row, {})[col + k] = text
                    size += len(text) + 3
                if size > limit:
                    cut = True
                    break
            elif rid == 0x0205 and len(data) >= 8:
                value, is_error = data[6], data[7]
                cell = (u16(data, 0), u16(data, 2), XLS_ERRORS.get(value, '#ERROR') if is_error else ('TRUE' if value else 'FALSE'))
            elif rid == 0x0006 and len(data) >= 14:
                row, col, xf = u16(data, 0), u16(data, 2), u16(data, 4)
                result = data[6:14]
                if result[6:8] == b'\xff\xff':
                    if result[0] == 0:
                        formula_cell = (row, col)
                    elif result[0] == 1:
                        cell = (row, col, 'TRUE' if result[2] else 'FALSE')
                    elif result[0] == 2:
                        cell = (row, col, XLS_ERRORS.get(result[2], '#ERROR'))
                else:
                    cell = (row, col, value_text(struct.unpack('<d', result)[0], xf))
            elif rid == 0x0207 and formula_cell is not None and len(data) >= 3:
                cell = (formula_cell[0], formula_cell[1], xl_string(data, 0))
                formula_cell = None
            if cell is not None and cell[2] != '':
                rows.setdefault(cell[0], {})[cell[1]] = cell[2]
                size += len(cell[2]) + 3
                if size > limit:
                    cut = True
                    break
        emit_rows(rows, out)
        if cut:
            raise Full()


# Outlook (.msg)

def msg_props(cfb, index):
    found = {}
    for name, child in cfb.children(index).items():
        if name.startswith('__substg1.0_') and len(name) == 20:
            found[name[12:20].upper()] = child
    return found


def msg_string(cfb, props, prop_id):
    for kind, codec in (('001F', 'utf-16-le'), ('001E', 'cp1252')):
        child = props.get(prop_id + kind)
        if child is not None:
            data = cfb.stream(child)
            if data is not None:
                return data.decode(codec, 'replace').rstrip('\x00')
    return ''


def msg_date(cfb, index, header):
    data = cfb.named(index, '__properties_version1.0')
    if data is None:
        return ''
    for offset in range(header, len(data) - 15, 16):
        tag = u32(data, offset)
        if tag in (0x00390040, 0x0E060040):
            value = struct.unpack_from('<Q', data, offset + 8)[0]
            try:
                moment = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=value // 10)
            except OverflowError:
                return ''
            return moment.strftime('%Y-%m-%d %H:%M UTC')
    return ''


def read_msg(cfb, index, out, depth, header):
    props = msg_props(cfb, index)
    sender = msg_string(cfb, props, '0C1A')
    address = msg_string(cfb, props, '5D01') or msg_string(cfb, props, '0C1F')
    if address and '@' in address:
        sender = (sender + ' <' + address + '>') if sender else address
    for label, value in (('From', sender), ('To', msg_string(cfb, props, '0E04')), ('Cc', msg_string(cfb, props, '0E03')),
                         ('Date', msg_date(cfb, index, header)), ('Subject', msg_string(cfb, props, '0037'))):
        if value:
            out.line(label + ': ' + value)
    out.line('')
    body = msg_string(cfb, props, '1000')
    if not body.strip():
        html_child = props.get('10130102') or props.get('1013001F') or props.get('1013001E')
        if html_child is not None:
            raw = cfb.stream(html_child) or b''
            text = raw.decode('utf-16-le', 'replace') if html_child == props.get('1013001F') else decode_html(raw)
            body = '\n'.join(html_lines(text))
    if not body.strip() and '10090102' in props:
        body = '(The message body is stored only as formatted text that cannot be read here.)'
    for line in body.replace('\r\n', '\n').split('\n'):
        out.line(line)
    for name, child in sorted(cfb.children(index).items()):
        if not name.startswith('__attach_version1.0_'):
            continue
        attach = msg_props(cfb, child)
        filename = msg_string(cfb, attach, '3707') or msg_string(cfb, attach, '3704') or 'attachment'
        storage = cfb.children(child).get('__substg1.0_3701000D')
        out.line('')
        if storage is not None:
            out.line('--- Attached email: ' + filename + ' ---')
            if depth < MAX_DEPTH:
                read_msg(cfb, storage, out, depth + 1, 24)
            continue
        data = cfb.stream(attach['37010102']) if '37010102' in attach else None
        attachment(filename, data, out, depth)


# ---------- email (.eml) ----------

def part_text(part):
    try:
        return part.get_content()
    except (LookupError, UnicodeError, AssertionError, KeyError):
        return decode_text(part.get_payload(decode=True) or b'')


def read_eml(data, out, depth):
    message = email.message_from_bytes(data, policy=policy.default)
    if not any(message.get(h) for h in ('From', 'To', 'Subject', 'Date', 'Message-ID')):
        raise Problem('NOT_SUPPORTED')
    emit_email(message, out, depth)


def emit_email(message, out, depth):
    for header in ('From', 'To', 'Cc', 'Date', 'Subject'):
        try:
            value = message.get(header)
        except Exception:
            value = next((v for k, v in message.raw_items() if k.lower() == header.lower()), None)
        if value:
            out.line(header + ': ' + ' '.join(str(value).split()))
    out.line('')
    body = message.get_body(preferencelist=('plain', 'html'))
    if body is not None:
        text = part_text(body)
        lines = html_lines(text) if body.get_content_type() == 'text/html' else text.replace('\r\n', '\n').split('\n')
        for line in lines:
            out.line(line)
    for part in message.iter_attachments():
        out.line('')
        kind = part.get_content_type()
        filename = part.get_filename() or ''
        if kind == 'message/rfc822':
            out.line('--- Attached email' + (': ' + filename if filename else '') + ' ---')
            inner = part.get_payload()
            inner = inner[0] if isinstance(inner, list) and inner else inner
            if depth < MAX_DEPTH and hasattr(inner, 'get_body'):
                emit_email(inner, out, depth + 1)
            continue
        if not filename and kind.startswith('text/'):
            filename = 'attachment.' + ('html' if kind == 'text/html' else 'txt')
        attachment(filename or 'attachment', part.get_payload(decode=True), out, depth)


ATTACHMENT_NOTE = {
    '.pdf': 'a PDF', '.png': 'a picture', '.jpg': 'a picture', '.jpeg': 'a picture', '.gif': 'a picture',
    '.tif': 'a picture', '.tiff': 'a picture', '.bmp': 'a picture', '.webp': 'a picture', '.heic': 'a picture',
}


def attachment(filename, data, out, depth):
    ext = ('.' + filename.rsplit('.', 1)[-1].lower()) if '.' in filename else ''
    size = len(data) if data else 0
    out.line('--- Attachment: ' + filename + ' (' + human_size(size) + ') ---')
    if not data:
        out.line('(The attachment is empty.)')
        return
    if ext in ATTACHMENT_NOTE:
        out.line('(This attachment is ' + ATTACHMENT_NOTE[ext] + '. Its text is not read inside the email; '
                 'save it as its own file to read it.)')
        return
    if depth >= MAX_DEPTH:
        out.line('(Attachments nested this deep are not read.)')
        return
    inner = Out()
    inner.size = out.size
    try:
        dispatch(data, ext, inner, depth + 1)
    except Problem as problem:
        out.line('(This attachment could not be read: ' + PROBLEM_TEXT.get(str(problem), PROBLEM_TEXT['UNREADABLE']) + ')')
        return
    except Full:
        out.lines.extend(inner.lines)
        out.size = inner.size
        raise
    except (RecursionError, MemoryError):
        raise
    except Exception:
        out.line('(This attachment could not be read: ' + PROBLEM_TEXT['UNREADABLE'] + ')')
        return
    out.lines.extend(inner.lines)
    out.size = inner.size


def human_size(size):
    if size >= 1 << 20:
        return '%.1f MB' % (size / (1 << 20))
    if size >= 1 << 10:
        return '%d KB' % (size // (1 << 10))
    return '%d bytes' % size


PROBLEM_TEXT = {
    'DAMAGED': 'the file is damaged or incomplete.',
    'PROTECTED': 'the file is protected with a password.',
    'OLD_FORMAT': 'the file is in a very old format.',
    'TOO_BIG': 'the file is too large to read.',
    'NOT_SUPPORTED': 'this kind of file cannot be read.',
    'UNREADABLE': 'the file may be damaged.',
}


# ---------- dispatch ----------

TEXT_EXTENSIONS = {'.txt', '.text', '.md', '.markdown', '.log', '.json', '.xml', '.ics', '.vcf', '.yaml', '.yml'}


def dispatch(data, ext, out, depth):
    head = data[:16].lstrip(b'\xef\xbb\xbf \t\r\n')
    if data[:8] == OLE:
        read_cfb(data, out, depth)
    elif data[:4] == b'PK\x03\x04':
        read_zip(data, out)
    elif head.startswith(b'{\\rtf'):
        read_rtf(data, out)
    elif data[:5] == b'%PDF-':
        raise Problem('NOT_SUPPORTED')
    elif ext in ('.eml', '.mht', '.mhtml'):
        read_eml(data, out, depth)
    elif ext in ('.html', '.htm', '.xhtml') or (
            ext in ('.doc', '.xls', '.xlsx', '.docx', '.ppt') and re.match(rb'\s*<', data[:512]) and
            re.search(rb'<(html|table|body)', data[:8192], re.I)):
        read_html(data, out)
    elif ext in ('.csv', '.tsv') or (ext == '.xls' and b'\t' in data[:4096]):
        read_csv(data, out, ext != '.csv')
    elif ext in TEXT_EXTENSIONS:
        plain_lines(decode_text(data), out)
    elif ext in ('.doc', '.docx', '.docm', '.dotx', '.xls', '.xlsx', '.xlsm', '.pptx', '.pptm', '.ppsx', '.odt',
                 '.ods', '.odp', '.msg', '.rtf'):
        raise Problem('DAMAGED')
    else:
        raise Problem('NOT_SUPPORTED')


def main():
    with open(path, 'rb') as handle:
        data = handle.read()
    out = Out()
    truncated = False
    try:
        dispatch(data, hint, out, 0)
    except Full:
        truncated = True
    print(mark + ('OK TRUNCATED' if truncated else 'OK'))
    print('\n'.join(out.lines)[:limit])


try:
    sys.setrecursionlimit(5000)
    main()
except Problem as problem:
    print(mark + 'ERR:' + str(problem))
except MemoryError:
    print(mark + 'ERR:TOO_BIG')
except RecursionError:
    print(mark + 'ERR:UNREADABLE')
except Exception:
    print(mark + 'ERR:UNREADABLE')
`;

export const UNREADABLE_MESSAGE = "Aman couldn't read this file. It may be damaged. Ask the sender to send it again.";

/** The plain sentence for each code the reader can answer with. */
export const DOCUMENT_TEXT_PROBLEMS = {
  DAMAGED: 'The file is damaged or incomplete. Ask the sender to send it again.',
  PROTECTED:
    'The file is protected with a password. Open it, save a copy without the password, and send that copy again.',
  OLD_FORMAT:
    'The file is saved in a very old format that cannot be read. Open it and save it in a current format (for example .docx, .xlsx or .pptx), or as a PDF, and send it again.',
  TOO_BIG: 'The file is too large to read.',
  NOT_SUPPORTED: 'The contents of the file are not a kind of document that can be read.',
  UNREADABLE: UNREADABLE_MESSAGE,
} satisfies Record<string, string>;

export interface DocumentTextResult {
  text: string;
  /** True when the file held more text than the reader was allowed to return. */
  truncated: boolean;
}

/** The document text from the script's output, or the plain reason it could not be read. */
export function parseDocumentTextOutput(input: { output: string; marker: string }): DocumentTextResult {
  const at = input.output.indexOf(input.marker);
  if (at < 0) {
    throw new Error('The document reader gave no answer.');
  }
  const after = input.output.slice(at + input.marker.length);
  const status = after.split('\n', 1)[0]?.trim() ?? '';
  if (status.startsWith('ERR:')) {
    const code = status.slice(4);
    throw new Error(Object.entries(DOCUMENT_TEXT_PROBLEMS).find(([key]) => key === code)?.[1] ?? UNREADABLE_MESSAGE);
  }
  if (status !== 'OK' && status !== 'OK TRUNCATED') {
    throw new Error(UNREADABLE_MESSAGE);
  }
  const newline = after.indexOf('\n');
  return { text: newline < 0 ? '' : after.slice(newline + 1), truncated: status === 'OK TRUNCATED' };
}

/** Characters of a document shown as one page, about what a printed page holds. */
const TEXT_PAGE_CHARS = 3000;

/** The text cut into pages of whole lines, so page_start and page_end work on these files as they do on a PDF. */
export function splitTextPages(text: string): string[] {
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
    while (rest.length > TEXT_PAGE_CHARS) {
      // Never cut between the two halves of a character outside the basic plane.
      const cutAt = /[\ud800-\udbff]/.test(rest.charAt(TEXT_PAGE_CHARS - 1)) ? TEXT_PAGE_CHARS - 1 : TEXT_PAGE_CHARS;
      flush();
      pages.push(rest.slice(0, cutAt));
      rest = rest.slice(cutAt);
    }
    if (size + rest.length + 1 > TEXT_PAGE_CHARS) {
      flush();
    }
    current.push(rest);
    size += rest.length + 1;
  }
  flush();
  return pages.filter(page => page.trim().length > 0);
}
