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
// Longest first, so `:-` wins over `-` and `##` over `#`.
const EXPANSION_OPERATORS = [':-', ':+', ':=', '##', '%%', '-', '+', '=', '#', '%'];
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
 * quotes, backslash escapes, `$NAME` and special parameters, and the `${...}`
 * forms that parameterExpansionEnd lists. It returns null for pipelines,
 * lists, redirections, background jobs, subshells, compound commands,
 * comments, leading assignments, any command, process or arithmetic
 * substitution, ANSI-C quoting, unterminated quotes, and every other `${...}`
 * form. Null never causes a wrong "ok"; it only means the caller cannot vouch
 * for the command's exit status.
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
      if (isPidThenSubstitution(command, i)) {
        return false;
      }
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
 * or null unless the body is one of the forms bash expands without error:
 * `${P}`, `${#NAME}`, or `${P<op>WORD}` (P not `#` or `!`) with op one of `:-` `-` `:+` `+`
 * `:=` `=` (NAME only) `#` `##` `%` `%%`. WORD may hold plain characters,
 * `$NAME`, special parameters and nested expansions of these forms; quotes,
 * backslashes, newlines and any command, process or arithmetic substitution
 * make it null.
 */
function parameterExpansionEnd(command: string, start: number): number | null {
  if (command[start] === '#') {
    const lengthEnd = parameterEnd(command, start + 1);
    if (lengthEnd !== null && lengthEnd.isName && command[lengthEnd.end] === '}') {
      return lengthEnd.end;
    }
  }
  // After `${`, bash reads a leading `#` or `!` as a length or indirection prefix,
  // so `$#` and `$!` are only safe here on their own.
  if ((command[start] === '#' || command[start] === '!') && command[start + 1] !== '}') {
    return null;
  }
  const parameter = parameterEnd(command, start);
  if (parameter === null) {
    return null;
  }
  let i = parameter.end;
  if (command[i] === '}') {
    return i;
  }
  const operator = EXPANSION_OPERATORS.find(op => command.startsWith(op, i));
  if (operator === undefined) {
    return null;
  }
  if (operator.endsWith('=') && !parameter.isName) {
    return null; // assigning to a positional or special parameter is an error
  }
  i += operator.length;
  while (i < command.length) {
    const ch = command[i] ?? '';
    if (ch === '}') {
      return i;
    }
    if (ch === "'" || ch === '"' || ch === '\\' || ch === '`' || ch === '\n' || ch === '\r') {
      return null;
    }
    if ((ch === '<' || ch === '>') && command[i + 1] === '(') {
      return null;
    }
    if (ch === '$') {
      const next = command[i + 1];
      if (next === '{') {
        const nestedEnd = parameterExpansionEnd(command, i + 2);
        if (nestedEnd === null) {
          return null;
        }
        i = nestedEnd + 1;
        continue;
      }
      if (next === '(' || next === '[' || next === "'" || next === '"') {
        return null;
      }
      if (isPidThenSubstitution(command, i)) {
        return null;
      }
      if (next !== undefined && (NAME_START.test(next) || SPECIAL_PARAMETERS.has(next))) {
        const nested = parameterEnd(command, i + 1);
        if (nested === null) {
          return null;
        }
        i = nested.end;
        continue;
      }
    }
    i += 1;
  }
  return null;
}

/** End of the parameter (name, digits or one special character) starting at `start`. */
function parameterEnd(command: string, start: number): { end: number; isName: boolean } | null {
  const first = command[start];
  if (first === undefined) {
    return null;
  }
  if (NAME_START.test(first)) {
    let end = start + 1;
    while (end < command.length && NAME_CHAR.test(command[end] ?? '')) {
      end += 1;
    }
    return { end, isName: true };
  }
  if (/[0-9]/.test(first)) {
    let end = start + 1;
    while (end < command.length && /[0-9]/.test(command[end] ?? '')) {
      end += 1;
    }
    return { end, isName: false };
  }
  if (SPECIAL_PARAMETERS.has(first)) {
    return { end: start + 1, isName: false };
  }
  return null;
}

/** Bash reads `$$(` as `$` followed by a command substitution, not as `$$` then `(`. */
function isPidThenSubstitution(command: string, dollarIndex: number): boolean {
  return command[dollarIndex + 1] === '$' && command[dollarIndex + 2] === '(';
}
