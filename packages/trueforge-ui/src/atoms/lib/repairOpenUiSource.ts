const STATEMENT_START = /^(\s*(?:[A-Za-z_$][\w$]*\s*=\s*)?)([A-Z]\w*)\[/;
const TRAILING_PAIRS = /^(\s*,\s*[A-Za-z_]\w*\s*=[^=].*)?$/;

/** Index of the `]` closing the `[` at `open`, skipping quoted strings; -1 when unbalanced. */
function findClosingBracket({ line, open }: { line: string; open: number }): number {
  let depth = 0;
  let quote = false;
  for (let i = open; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === '"') quote = false;
    } else if (ch === '"') quote = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function repairLine(line: string): string {
  const match = STATEMENT_START.exec(line);
  if (!match) return line;
  const [head = '', assignment = '', name = ''] = match;
  const open = head.length - 1;
  const close = findClosingBracket({ line, open });
  if (close < 0) return line;
  const rest = line.slice(close + 1);
  if (!TRAILING_PAIRS.test(rest)) return line;
  return `${assignment}${name}(${line.slice(open, close + 1)}${rest.trimEnd()})`;
}

/**
 * Models sometimes drop the round brackets in `name = Stack[a, b], direction="column"`.
 * Rewrites such single-line statements to `name = Stack([a, b], direction="column")`;
 * everything else is returned untouched.
 */
export function repairOpenUiSource(source: string): string {
  return source.split('\n').map(repairLine).join('\n');
}
