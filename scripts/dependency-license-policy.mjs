/**
 * License policy for third-party dependencies. Aman is MPL-2.0, so a
 * dependency must not carry a strong or network copyleft license, which would
 * force the combined work under its terms. Weak copyleft that stays with its
 * own files or library (MPL, LGPL, EPL) is compatible and allowed.
 */

// Each pattern names one strong or network copyleft family. GPL matches
// GPL-2.0, GPLv3 and AGPL-3.0 but not LGPL; the prose form skips the
// Lesser/Library GPL the same way.
const STRONG_COPYLEFT = [
  { name: 'GPL / AGPL', re: /\bA?GPL/i },
  { name: 'GPL / AGPL', re: /(?<!\b(?:lesser|library)\s+)general\s+public\s+licen[cs]e/i },
  { name: 'AGPL', re: /\baffero\b/i },
  { name: 'SSPL', re: /\bSSPL\b|server\s+side\s+public\s+licen[cs]e/i },
  { name: 'EUPL', re: /\bEUPL\b|european\s+union\s+public\s+licen[cs]e/i },
  { name: 'OSL', re: /\bOSL-\d|open\s+software\s+licen[cs]e/i },
  { name: 'RPL', re: /\bRPL-\d|reciprocal\s+public\s+licen[cs]e/i },
  { name: 'CPAL', re: /\bCPAL-\d|common\s+public\s+attribution\s+licen[cs]e/i },
  { name: 'Sleepycat', re: /\bsleepycat\b/i },
  { name: 'CC-BY-SA', re: /\bCC-BY(?:-NC)?-SA\b|share-?\s?alike/i },
];

/** The copyleft family a single license term matches, or null. */
export function copyleftFamily(term) {
  const hit = STRONG_COPYLEFT.find(({ re }) => re.test(term));
  return hit ? hit.name : null;
}

function tokenize(expression) {
  return expression.match(/\(|\)|[^\s()]+/g) ?? [];
}

/**
 * Evaluates a license expression (SPDX-style AND / OR / WITH and parentheses,
 * tolerating free text) and returns the copyleft families that cannot be
 * avoided: an OR is clean when any branch is clean, an AND only when every
 * part is. Unbalanced or free-form text is judged as one term.
 */
export function unavoidableCopyleft(expression) {
  const tokens = tokenize(expression);
  let pos = 0;

  const parseOr = () => {
    const branches = [parseAnd()];
    while (tokens[pos]?.toUpperCase() === 'OR') {
      pos += 1;
      branches.push(parseAnd());
    }
    const clean = branches.find(b => b.length === 0);
    return clean ?? [...new Set(branches.flat())];
  };

  const parseAnd = () => {
    const found = [...parseTerm()];
    while (tokens[pos]?.toUpperCase() === 'AND') {
      pos += 1;
      found.push(...parseTerm());
    }
    return [...new Set(found)];
  };

  const parseTerm = () => {
    if (tokens[pos] === '(') {
      pos += 1;
      const inner = parseOr();
      if (tokens[pos] !== ')') {
        throw new Error('unbalanced');
      }
      pos += 1;
      return inner;
    }
    const words = [];
    while (
      pos < tokens.length &&
      !['(', ')'].includes(tokens[pos]) &&
      !['AND', 'OR'].includes(tokens[pos].toUpperCase())
    ) {
      words.push(tokens[pos]);
      pos += 1;
    }
    if (words.length === 0) {
      throw new Error('empty term');
    }
    const family = copyleftFamily(words.join(' '));
    return family ? [family] : [];
  };

  try {
    const result = parseOr();
    if (pos !== tokens.length) {
      throw new Error('trailing tokens');
    }
    return result;
  } catch {
    const family = copyleftFamily(expression);
    return family ? [family] : [];
  }
}

/**
 * Judges one package. `declared` lists the license statements the package
 * makes (an SPDX expression, a license field, trove classifiers). Each one
 * must be free of unavoidable copyleft. A package that declares nothing is
 * judged by the text it ships (README, LICENSE), where any copyleft mention
 * fails it. Returns the problem as a sentence, or null when the package passes.
 */
export function licenseProblem({ declared, shippedText }) {
  const statements = declared.map(s => s.trim()).filter(Boolean);
  if (statements.length > 0) {
    const families = [...new Set(statements.flatMap(unavoidableCopyleft))];
    return families.length > 0 ? `uses a ${families.join(', ')} license (${statements.join('; ')})` : null;
  }
  if (shippedText === null) {
    return 'declares no license and ships no text to check';
  }
  const family = copyleftFamily(shippedText);
  return family ? `declares no license, and its README or license file mentions ${family}` : null;
}
