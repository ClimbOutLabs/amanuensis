import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

export type StructuredReportRowStatus = 'included' | 'conflict' | 'uncertain' | 'info';

export interface StructuredReportRow {
  label: string;
  value: string;
  status: StructuredReportRowStatus;
  sources: string[];
}

export interface StructuredReportSection {
  heading: string;
  rows: StructuredReportRow[];
}

export interface StructuredDocumentReport {
  title: string;
  summary: string;
  sections: StructuredReportSection[];
  notes: string[];
}

export const DOCUMENT_REPORT_MAX_SECTIONS = 2;
export const DOCUMENT_REPORT_MAX_ROWS = 16;
export const DOCUMENT_REPORT_MAX_NOTES = 4;
export const DOCUMENT_REPORT_MAX_NOTE_LENGTH = 500;
export const DOCUMENT_REPORT_MAX_SOURCE_LENGTH = 240;

function assertReportBounds(report: StructuredDocumentReport): void {
  if (report.title.trim().length === 0 || report.title.length > 120) {
    throw new Error('Report title must contain 1-120 characters');
  }
  if (report.summary.length > 500) {
    throw new Error('Report summary exceeds 500 characters');
  }
  if (report.sections.length > DOCUMENT_REPORT_MAX_SECTIONS || report.notes.length > DOCUMENT_REPORT_MAX_NOTES) {
    throw new Error('Report exceeds the compact section or note limit');
  }
  const rowCount = report.sections.reduce((count, section) => count + section.rows.length, 0);
  if (rowCount > DOCUMENT_REPORT_MAX_ROWS) {
    throw new Error('Report exceeds the compact row limit');
  }
  if (report.notes.some(note => note.length > DOCUMENT_REPORT_MAX_NOTE_LENGTH)) {
    throw new Error('Report note exceeds the bounded renderer contract');
  }
  for (const section of report.sections) {
    if (section.heading.length > 80) {
      throw new Error('Report section heading exceeds 80 characters');
    }
    for (const row of section.rows) {
      if (
        row.label.length > 160 ||
        row.value.length > 240 ||
        row.sources.length > 8 ||
        row.sources.some(source => source.length > DOCUMENT_REPORT_MAX_SOURCE_LENGTH)
      ) {
        throw new Error('Report row exceeds the bounded renderer contract');
      }
    }
  }
}

function cell(text: string, bold = false): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ bold, size: 16, text })] })],
  });
}

export async function createStructuredDocumentDocx(report: StructuredDocumentReport): Promise<Buffer> {
  assertReportBounds(report);
  const children: (Paragraph | Table)[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ bold: true, size: 24, text: report.title })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ bold: true, size: 20, text: report.summary })],
    }),
  ];
  for (const section of report.sections) {
    children.push(new Paragraph({ children: [new TextRun({ bold: true, size: 18, text: section.heading })] }));
    const rows = [
      new TableRow({
        children: [cell('Item', true), cell('Value', true), cell('Status', true), cell('Sources', true)],
      }),
      ...section.rows.map(
        row =>
          new TableRow({
            children: [cell(row.label), cell(row.value), cell(row.status), cell(row.sources.join(', '))],
          }),
      ),
    ];
    const table = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 2, color: 'B7C3D0' },
        bottom: { style: BorderStyle.SINGLE, size: 2, color: 'B7C3D0' },
        left: { style: BorderStyle.SINGLE, size: 2, color: 'B7C3D0' },
        right: { style: BorderStyle.SINGLE, size: 2, color: 'B7C3D0' },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'D9E1E8' },
        insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'D9E1E8' },
      },
      rows,
    });
    children.push(table);
  }
  for (const note of report.notes) {
    children.push(new Paragraph({ children: [new TextRun({ size: 15, text: `• ${note}` })] }));
  }
  const document = new Document({
    sections: [{ properties: { page: { margin: { top: 540, right: 540, bottom: 540, left: 540 } } }, children }],
  });
  return await Packer.toBuffer(document);
}
