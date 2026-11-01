/**
 * A command line that is exactly one simple command: a name and arguments made
 * of plain words. Each word is the literal text after quote removal.
 */
export interface SimpleShellCommand {
  name: string;
  args: string[];
}

const OPERATOR_CHARS = new Set(['|', '&', ';', '<', '>', '(', ')', '\n', '\r']);
const RESERVED_FIRST_WORDS = new Set([
  '!',
  '{',
  '}',
  '[[',
  ']]',
  'case',
  'coproc',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'time',
  'until',
  'while',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const SPECIAL_PARAMETERS = new Set([
  '@',
  '*',
  '#',
  '?',
  '-',
  '$',
  '!',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
]);

/**
 * Parses `command` as one simple command, or returns null when it is anything
 * else. Deliberately conservative: it accepts plain words, single and double
 * quotes, backslash escapes, and `$NAME` / `${...}` parameter expansions, and
 * returns null for pipelines, lists, redirections, background jobs,
 * subshells, compound commands, comments, leading assignments, command,
 * process or arithmetic substitution (anywhere, including inside double
 * quotes and parameter defaults), ANSI-C quoting, and unterminated quotes.
 * Null never causes a wrong "ok"; it only means the caller cannot vouch for
 * the command's exit status.
 */
export function parseSimpleShellCommand(command: string): SimpleShellCommand | null {
  const words: string[] = [];
  const rawWords: string[] = [];
  let word = '';
  let raw = '';
  let inWord = false;
  let i = 0;

  const endWord = () => {
    if (inWord) {
      words.push(word);
      rawWords.push(raw);
    }
    word = '';
    raw = '';
    inWord = false;
  };

  /** Consumes a `$...` expansion starting at `i`; returns false when it disqualifies the command. */
  const consumeDollar = (): boolean => {
    const next = command[i + 1];
    if (next === '(' || next === "'" || next === '"' || next === '[') {
      return false; // $( ), $(( )), $'...', $"...", $[ ]
    }
    if (next === '{') {
      const end = parameterExpansionEnd(command, i + 2);
      if (end === null) {
        return false;
      }
      word += command.slice(i, end + 1);
      raw += command.slice(i, end + 1);
      i = end + 1;
      return true;
    }
    if (next !== undefined && NAME_START.test(next)) {
      let j = i + 1;
      while (j < command.length && NAME_CHAR.test(command[j] ?? '')) {
        j += 1;
      }
      word += command.slice(i, j);
      raw += command.slice(i, j);
      i = j;
      return true;
    }
    if (next !== undefined && SPECIAL_PARAMETERS.has(next)) {
      word += command.slice(i, i + 2);
      raw += command.slice(i, i + 2);
      i += 2;
      return true;
    }
    word += '$';
    raw += '$';
    i += 1;
    return true;
  };

  while (i < command.length) {
    const ch = command[i] ?? '';
    if (ch === ' ' || ch === '\t') {
      endWord();
      i += 1;
      continue;
    }
    if (OPERATOR_CHARS.has(ch) || ch === '`') {
      return null;
    }
    if (ch === '#' && !inWord) {
      return null; // a comment: the line is not just this command
    }
    inWord = true;
    if (ch === '\\') {
      const escaped = command[i + 1];
      if (escaped === '\n') {
        return null;
      }
      // A trailing lone backslash is kept as a literal character.
      word += escaped ?? '\\';
      raw += command.slice(i, i + 2);
      i += escaped === undefined ? 1 : 2;
      continue;
    }
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) {
        return null;
      }
      word += command.slice(i + 1, close);
      raw += command.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      raw += '"';
      i += 1;
      let closed = false;
      while (i < command.length) {
        const c = command[i] ?? '';
        if (c === '"') {
          raw += '"';
          i += 1;
          closed = true;
          break;
        }
        if (c === '`') {
          return null;
        }
        if (c === '\\') {
          const escaped = command[i + 1];
          if (escaped !== undefined && '$`"\\\n'.includes(escaped)) {
            word += escaped;
          } else {
            word += '\\' + (escaped ?? '');
          }
          raw += command.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (c === '$') {
          if (!consumeDollar()) {
            return null;
          }
          continue;
        }
        word += c;
        raw += c;
        i += 1;
      }
      if (!closed) {
        return null;
      }
      continue;
    }
    if (ch === '$') {
      if (!consumeDollar()) {
        return null;
      }
      continue;
    }
    word += ch;
    raw += ch;
    i += 1;
  }
  endWord();

  const [name, ...args] = words;
  const firstRaw = rawWords[0];
  if (name === undefined || firstRaw === undefined || name === '') {
    return null;
  }
  if (ASSIGNMENT.test(firstRaw) || RESERVED_FIRST_WORDS.has(firstRaw)) {
    return null;
  }
  return { name, args };
}

/**
 * Index of the `}` closing a `${...}` expansion whose body starts at `start`,
 * or null when the body is unterminated or contains a command, process or
 * arithmetic substitution (including inside a `${VAR:-default}` value).
 */
function parameterExpansionEnd(command: string, start: number): number | null {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = start; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      }
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '`') {
      return null;
    }
    if (ch === '$' && (command[i + 1] === '(' || command[i + 1] === '[')) {
      return null;
    }
    if ((ch === '<' || ch === '>') && command[i + 1] === '(') {
      return null;
    }
    if (ch === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (ch === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (quote !== null) {
      continue;
    }
    if (ch === '$' && command[i + 1] === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return null;
}
