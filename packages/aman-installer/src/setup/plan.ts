// The plan the Review screen shows is the plan of a dry run, in the shape
// the installer prints it (print_plan in installer/lib/plan.sh): one row
// per step, its state word first ("done", "to do" or "needs admin"), the
// step's words after it, and the long lines wrapped under the row at the
// same column. With --verbose the same run also prints every download
// with its size. This reader turns that printed plan into rows the page
// can lay out; the run's progress never comes from here, only from the
// event stream.

export type PlanRowState = 'done' | 'todo' | 'admin';

export interface PlanRow {
  state: PlanRowState;
  text: string;
}

export interface PlanDownload {
  sizeMb: number;
  what: string;
  hosts: string;
}

export interface ParsedPlan {
  rows: PlanRow[];
  downloads: PlanDownload[];
  totalMb: number | null;
}

const ROW_PATTERN = /^ {2}\S (done|to do|needs admin)( +)(\S.*)$/;
const DOWNLOAD_PATTERN = /^\s+(\d+) MB\s{2}(.*) \(([^()]*)\)$/;
const TOTAL_PATTERN = /^\s+total: about (\d+) MB/;
const DOWNLOADS_HEADER = 'First-run downloads (approximate):';

function rowState(word: string): PlanRowState {
  if (word === 'done') return 'done';
  if (word === 'needs admin') return 'admin';
  return 'todo';
}

export function parsePlan(stdout: string): ParsedPlan {
  const rows: PlanRow[] = [];
  const downloads: PlanDownload[] = [];
  let totalMb: number | null = null;
  let textColumn: number | null = null;
  let inDownloads = false;
  for (const line of stdout.split('\n')) {
    if (line.includes(DOWNLOADS_HEADER)) {
      inDownloads = true;
      continue;
    }
    if (inDownloads) {
      const total = TOTAL_PATTERN.exec(line);
      if (total !== null && total[1] !== undefined) {
        totalMb = Number.parseInt(total[1], 10);
        continue;
      }
      const download = DOWNLOAD_PATTERN.exec(line);
      if (download !== null && download[1] !== undefined && download[2] !== undefined && download[3] !== undefined) {
        downloads.push({ sizeMb: Number.parseInt(download[1], 10), what: download[2].trim(), hosts: download[3] });
        continue;
      }
      if (line.trim() === '') {
        inDownloads = false;
      }
      continue;
    }
    const row = ROW_PATTERN.exec(line);
    if (row !== null && row[1] !== undefined && row[2] !== undefined && row[3] !== undefined) {
      textColumn = 4 + row[1].length + row[2].length;
      rows.push({ state: rowState(row[1]), text: row[3].trim() });
      continue;
    }
    // A line indented to the rows' text column, under a row, is the rest
    // of that row's words (the installer wraps long rows, and puts a
    // row's details at the same column).
    if (textColumn !== null && rows.length > 0 && line.startsWith(' '.repeat(textColumn))) {
      const rest = line.slice(textColumn).trim();
      const last = rows[rows.length - 1];
      if (rest !== '' && last !== undefined) {
        last.text = `${last.text} ${rest}`;
      }
    }
  }
  return { rows, downloads, totalMb };
}
