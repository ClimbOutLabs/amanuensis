/**
 * License policy for third-party dependencies. Aman is MPL-2.0, so every
 * dependency must carry a license from the accepted list below: permissive
 * licenses, plus weak copyleft that stays with its own files or library (MPL,
 * LGPL, EPL). Anything else fails, including strong or network copyleft,
 * source-available and proprietary terms, and licenses that are missing or
 * not recognised.
 */
import spdxExceptionIds from 'spdx-exceptions' with { type: 'json' };
import spdxLicenseIds from 'spdx-license-ids' with { type: 'json' };
import deprecatedSpdxLicenseIds from 'spdx-license-ids/deprecated.json' with { type: 'json' };

const SPDX_LICENSE_IDS = new Set([...spdxLicenseIds, ...deprecatedSpdxLicenseIds]);
const SPDX_EXCEPTION_IDS = new Set(spdxExceptionIds);

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

// SPDX exceptions that only grant extra permissions. `X WITH exception` passes
// only when X is accepted and the exception is listed here.
export const ACCEPTED_EXCEPTIONS = new Set([
  'Autoconf-exception-2.0',
  'Autoconf-exception-3.0',
  'Bison-exception-2.2',
  'Classpath-exception-2.0',
  'Font-exception-2.0',
  'GCC-exception-2.0',
  'GCC-exception-3.1',
  'Libtool-exception',
  'Linux-syscall-note',
  'LLVM-exception',
  'LZMA-exception',
  'OCaml-LGPL-linking-exception',
  'Qt-LGPL-exception-1.1',
  'Swift-exception',
  'Universal-FOSS-exception-1.0',
  'WxWindows-exception-3.1',
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

// Plain-text names of licenses that are never accepted. A statement that
// matches is a recognised license even when it is not an SPDX id.
const REJECTED_NAMES =
  /\b(?:A?GPL|L?GPL|General Public License|SSPL|Server Side Public|EUPL|European Union Public|BUSL|Business Source|Commons Clause|NonCommercial|ShareAlike|Proprietary|Elastic License)\b/i;

const TROVE_PREFIX = 'License ::';

/** The license name inside a Python trove classifier, or the statement unchanged. */
function withoutTrovePrefix(statement) {
  return statement.startsWith(TROVE_PREFIX) ? statement.split('::').at(-1).trim() : statement;
}

/** The accepted SPDX id or family a single license term stands for, or null. */
export function acceptedLicense(term) {
  const trimmed = withoutTrovePrefix(term.trim());
  const id = ALIASES.get(trimmed.toLowerCase()) ?? trimmed;
  return ACCEPTED_LICENSES.has(id) || ACCEPTED_FAMILIES.has(id) ? id : null;
}

/**
 * Parses an SPDX expression into a tree of `{ id, exception? }` leaves joined
 * by `{ op: 'AND' | 'OR', left, right }`, or returns null when it is not
 * well formed. AND binds tighter than OR; parentheses group.
 */
function parseExpression(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const keyword = word => tokens[pos]?.toUpperCase() === word;
  const isOperand = token => token !== undefined && token !== '(' && token !== ')' && !/^(AND|OR|WITH)$/i.test(token);

  const parseBinary = (op, parseOperand) => {
    let node = parseOperand();
    while (keyword(op)) {
      pos += 1;
      node = { op, left: node, right: parseOperand() };
    }
    return node;
  };
  const parseOr = () => parseBinary('OR', () => parseBinary('AND', parseTerm));
  const parseTerm = () => {
    if (tokens[pos] === '(') {
      pos += 1;
      const node = parseOr();
      if (tokens[pos] !== ')') {
        throw new Error('unbalanced parentheses');
      }
      pos += 1;
      return node;
    }
    const id = tokens[pos];
    if (!isOperand(id)) {
      throw new Error('missing license id');
    }
    pos += 1;
    if (!keyword('WITH')) {
      return { id };
    }
    const exception = tokens[pos + 1];
    if (!isOperand(exception)) {
      throw new Error('missing exception id');
    }
    pos += 2;
    return { id, exception };
  };

  try {
    const tree = parseOr();
    return pos === tokens.length ? tree : null;
  } catch {
    return null;
  }
}

function evaluate(node, leaf) {
  if ('op' in node) {
    const left = evaluate(node.left, leaf);
    const right = evaluate(node.right, leaf);
    return node.op === 'AND' ? left && right : left || right;
  }
  return leaf(node);
}

function everyLeaf(node, test) {
  return 'op' in node ? everyLeaf(node.left, test) && everyLeaf(node.right, test) : test(node);
}

/**
 * Whether an SPDX expression is acceptable: an OR passes when any branch
 * passes, an AND only when every part does. `X WITH exception` passes when X
 * is accepted and the exception is on the accepted exception list. Anything
 * that is not a well-formed expression of known terms is not acceptable.
 */
export function expressionAccepted(expression) {
  const tree = parseExpression(expression);
  return (
    tree !== null &&
    evaluate(
      tree,
      ({ id, exception }) =>
        acceptedLicense(id) !== null && (exception === undefined || ACCEPTED_EXCEPTIONS.has(exception)),
    )
  );
}

/**
 * Whether a license statement names a known license, accepted or not: a
 * Python trove classifier, an accepted name, npm's UNLICENSED, an SPDX
 * expression made only of SPDX ids, or the plain name of a rejected license.
 * A reviewed entry may only stand in for metadata that is missing or not
 * recognised.
 */
export function recognisedLicense(statement) {
  const trimmed = statement.trim();
  if (trimmed.startsWith(TROVE_PREFIX) || acceptedLicense(trimmed) !== null || trimmed === 'UNLICENSED') {
    return true;
  }
  const tree = parseExpression(trimmed);
  if (
    tree !== null &&
    everyLeaf(
      tree,
      ({ id, exception }) =>
        SPDX_LICENSE_IDS.has(id.replace(/\+$/, '')) && (exception === undefined || SPDX_EXCEPTION_IDS.has(exception)),
    )
  ) {
    return true;
  }
  return REJECTED_NAMES.test(trimmed);
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

/**
 * Judges a reviewed entry against the package's own metadata. An entry may
 * only replace metadata that is missing or not recognised, so it can never
 * overrule a license the package declares. Returns the problem as a sentence,
 * or null when the entry may be used.
 */
export function reviewedEntryProblem(declaredStatements) {
  const recognised = declaredStatements.map(s => s.trim()).filter(s => s !== '' && recognisedLicense(s));
  if (recognised.length === 0) {
    return null;
  }
  return `has a reviewed entry, but its own metadata already names a license (${recognised.map(s => s.slice(0, 120)).join('; ')}). A reviewed entry can only fill in missing or unclear metadata. Remove the entry`;
}
