/**
 * License policy for third-party dependencies. Aman is MPL-2.0, so every
 * dependency must carry a license from the accepted list below: permissive
 * licenses, plus weak copyleft that stays with its own files or library (MPL,
 * LGPL, EPL). Anything else fails, including strong or network copyleft,
 * source-available and proprietary terms, and licenses that are missing or
 * not recognised.
 */

export const ACCEPTED_LICENSES = new Set([
  '0BSD',
  'AFL-2.1',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'CNRI-Python',
  'EPL-2.0',
  'FTL',
  'HPND',
  'IJG',
  'ISC',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'libpng-2.0',
  'libtiff',
  'MIT',
  'MIT-0',
  'MIT-CMU',
  'MPL-2.0',
  'OFL-1.1',
  'PSF-2.0',
  'Python-2.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'W3C',
  'X11',
  'Zlib',
]);

const ACCEPTED_FAMILIES = new Set(['Apache family', 'BSD family', 'public domain']);

// Exact spellings packages use instead of an SPDX id, mapped to what they
// mean. Includes the Python trove classifier names. A family name ("BSD",
// "Apache") is accepted only because every license in that family is.
const ALIASES = new Map(
  Object.entries({
    apache: 'Apache family',
    bsd: 'BSD family',
    'bsd license': 'BSD family',
    'modified bsd license': 'BSD-3-Clause',
    'new bsd license': 'BSD-3-Clause',
    'public domain': 'public domain',
    'apache 2.0': 'Apache-2.0',
    'apache license 2.0': 'Apache-2.0',
    'apache license, version 2.0': 'Apache-2.0',
    'apache software license': 'Apache-2.0',
    'apache-2': 'Apache-2.0',
    'bsd 3-clause': 'BSD-3-Clause',
    '3-clause bsd license': 'BSD-3-Clause',
    'isc license (iscl)': 'ISC',
    'mit license': 'MIT',
    'mozilla public license 2.0 (mpl 2.0)': 'MPL-2.0',
    'python software foundation license': 'PSF-2.0',
    'the unlicense (unlicense)': 'Unlicense',
    'gnu lesser general public license v2 or later (lgplv2+)': 'LGPL-2.1-or-later',
    'gnu lesser general public license v3 (lgplv3)': 'LGPL-3.0-only',
    'gnu lesser general public license v3 or later (lgplv3+)': 'LGPL-3.0-or-later',
  }),
);

/** The accepted SPDX id a single license term stands for, or null. */
export function acceptedLicense(term) {
  const trimmed = term.trim();
  const id = ALIASES.get(trimmed.toLowerCase()) ?? trimmed;
  return ACCEPTED_LICENSES.has(id) || ACCEPTED_FAMILIES.has(id) ? id : null;
}

/**
 * Whether an SPDX expression is acceptable: an OR passes when any branch
 * passes, an AND only when every part does. `X WITH exception` is judged by X,
 * since an exception only ever grants more. Parentheses group. Anything that is
 * not a well-formed expression of known terms is not acceptable.
 */
export function expressionAccepted(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const keyword = word => tokens[pos]?.toUpperCase() === word;

  const parseOr = () => {
    let ok = parseAnd();
    while (keyword('OR')) {
      pos += 1;
      ok = parseAnd() || ok;
    }
    return ok;
  };

  const parseAnd = () => {
    let ok = parseTerm();
    while (keyword('AND')) {
      pos += 1;
      ok = parseTerm() && ok;
    }
    return ok;
  };

  const parseTerm = () => {
    if (tokens[pos] === '(') {
      pos += 1;
      const ok = parseOr();
      if (tokens[pos] !== ')') {
        throw new Error('unbalanced parentheses');
      }
      pos += 1;
      return ok;
    }
    const id = tokens[pos];
    if (id === undefined || id === ')' || keyword('AND') || keyword('OR') || keyword('WITH')) {
      throw new Error('missing license id');
    }
    pos += 1;
    if (keyword('WITH')) {
      pos += 2;
    }
    return acceptedLicense(id) !== null;
  };

  try {
    const ok = parseOr();
    return pos === tokens.length && ok;
  } catch {
    return false;
  }
}

/**
 * Judges one package from its license statements. Each statement is either a
 * whole-string alias or an SPDX expression, and every statement must be
 * acceptable. Returns the problem as a sentence, or null when the package
 * passes.
 */
export function licenseProblem(statements) {
  const declared = statements.map(s => s.trim()).filter(Boolean);
  if (declared.length === 0) {
    return 'declares no license';
  }
  const rejected = declared.filter(s => acceptedLicense(s) === null && !expressionAccepted(s));
  if (rejected.length === 0) {
    return null;
  }
  return `has a license that is not on the accepted list: ${rejected.map(s => s.split('\n')[0].slice(0, 120)).join('; ')}`;
}
