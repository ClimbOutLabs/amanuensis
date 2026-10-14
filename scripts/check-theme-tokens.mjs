#!/usr/bin/env node
/**
 * Theme-token guard: every UI surface must get its colors from the app's
 * themes (Settings > Themes), never from fixed values.
 *
 * Scans packages/trueforge-ui/src and packages/frontend/src and fails on:
 * - hex color literals (#fff, #1a1a1a), except fully-transparent #00000000
 * - rgb(), rgba(), hsl(), hsla() literals
 * - named CSS colors used as values (white, black, ...)
 * - Tailwind built-in palette classes (bg-white, text-gray-500, ...)
 *
 * Allowed: theme definition files (packages/trueforge-ui/src/theme/** and
 * src/styles.css, where the tokens live), test files, the values
 * `transparent` / `currentColor` / `inherit`, `var(--*)` references, and
 * explicit allowlist entries in scripts/theme-token-allowlist.txt, one per
 * line: `path :: reason` exempts a whole file, `path | text :: reason` exempts
 * only lines containing `text`. A line-scoped entry that matches no
 * violation is stale and fails the run.
 *
 * Usage: node scripts/check-theme-tokens.mjs [--root <repo root>] [--allowlist <file>]
 * Exit 0 when clean, 1 with a violation list otherwise.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const scanRoot = rootFlag === -1 ? root : resolve(args[rootFlag + 1]);
const allowlistFlag = args.indexOf('--allowlist');
const allowlistPath = allowlistFlag === -1 ? join(here, 'theme-token-allowlist.txt') : resolve(args[allowlistFlag + 1]);

const SCAN_DIRS = ['packages/trueforge-ui/src', 'packages/frontend/src'];
const SCAN_EXTS = new Set(['.tsx', '.ts', '.jsx', '.js', '.css']);

// Whole files that define the themes themselves; fixed values here are the
// token definitions, not violations.
const THEME_DEFINITION_RES = [/packages\/trueforge-ui\/src\/theme\//, /packages\/trueforge-ui\/src\/styles\.css$/];

function loadAllowlist() {
  const entries = [];
  if (!existsSync(allowlistPath)) {
    return entries;
  }
  for (const raw of readFileSync(allowlistPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const [location, ...reasonParts] = line.split('::').map(s => s.trim());
    const reason = reasonParts.join(':: ');
    if (!reason) {
      throw new Error(`theme-token-allowlist: entry has no reason: ${line}`);
    }
    const sep = location.indexOf('|');
    const file = sep === -1 ? location : location.slice(0, sep).trim();
    const text = sep === -1 ? null : location.slice(sep + 1).trim();
    entries.push({ file, text: text || null, reason, used: false });
  }
  return entries;
}

function isTestFile(rel) {
  const parts = rel.split('/');
  return (
    parts.includes('test') ||
    parts.includes('tests') ||
    parts.includes('__tests__') ||
    /\.test\.[^.]+$/.test(rel) ||
    /\.spec\.[^.]+$/.test(rel) ||
    /\.stories\.[^.]+$/.test(rel)
  );
}

function isThemeDefinition(rel) {
  return THEME_DEFINITION_RES.some(re => re.test(rel));
}

const HEX_RE = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b/g;
// #00000000 / #0000 is `transparent` written longhand; the rule allows transparent.
const TRANSPARENT_HEX_RE = /^#0{4}$|^#0{8}$/i;
const COLOR_FN_RE = /\b(?:rgb|rgba|hsl|hsla)\s*\(/gi;

const NAMED_COLORS = new Set(
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgrey darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray grey green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgrey lightgreen lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(
    ' ',
  ),
);
// A named color used as a CSS/JS value: after `:` or `=` (optionally quoted),
// terminated by `;`, `,`, `)`, `}` or end of line.
const NAMED_COLOR_RE = new RegExp(`[:=]\\s*["']?(${[...NAMED_COLORS].join('|')})["']?\\s*(?=[;,)}\\)]|$)`, 'gi');

const TW_PREFIXES = [
  'bg',
  'text',
  'border',
  'ring',
  'fill',
  'stroke',
  'from',
  'to',
  'via',
  'outline',
  'divide',
  'placeholder',
  'shadow',
  'decoration',
  'accent',
  'caret',
];
const TW_PALETTE = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  'white',
  'black',
];
// Matches built-in palette utilities, including stacked variants
// (dark:hover:bg-red-500/50) but not token classes (bg-card-bg) or
// arbitrary values (bg-[var(--overlay)]).
const TW_PALETTE_RE = new RegExp(
  `(?<![\\w-])(?:[a-z][\\w-]*:)*(?:${TW_PREFIXES.join('|')})-(?:${TW_PALETTE.join('|')})(?:-\\d{2,3})?(?:\\/\\d+)?(?![\\w-])`,
  'g',
);

function checkLine(line) {
  const violations = [];
  for (const m of line.matchAll(HEX_RE)) {
    if (!TRANSPARENT_HEX_RE.test(m[0])) {
      violations.push(`hex color ${m[0]}`);
    }
  }
  for (const m of line.matchAll(COLOR_FN_RE)) {
    violations.push(`color function ${m[0].trim()}(`);
  }
  // Named colors: skip `transparent`, `currentColor`, `inherit` (allowed).
  for (const m of line.matchAll(NAMED_COLOR_RE)) {
    violations.push(`named color ${m[1].toLowerCase()}`);
  }
  for (const m of line.matchAll(TW_PALETTE_RE)) {
    violations.push(`palette class ${m[0]}`);
  }
  return violations;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') {
        continue;
      }
      yield* walk(full);
    } else if (SCAN_EXTS.has(entry.slice(entry.lastIndexOf('.')))) {
      yield full;
    }
  }
}

function main() {
  const allowlist = loadAllowlist();
  const wholeFile = new Set(allowlist.filter(e => e.text === null).map(e => e.file));
  const scoped = allowlist.filter(e => e.text !== null);
  const violations = [];
  let scanned = 0;

  for (const dir of SCAN_DIRS) {
    const abs = join(scanRoot, dir);
    if (!existsSync(abs)) {
      continue;
    }
    for (const full of walk(abs)) {
      const rel = relative(scanRoot, full).replace(/\\/g, '/');
      if (isTestFile(rel) || isThemeDefinition(rel) || wholeFile.has(rel)) {
        continue;
      }
      scanned++;
      const text = readFileSync(full, 'utf8');
      text.split('\n').forEach((line, i) => {
        const stripped = line.trim();
        // Skip pure comment lines; colors inside comments are documentation.
        if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*')) {
          return;
        }
        const found = checkLine(line);
        if (found.length === 0) {
          return;
        }
        const exemption = scoped.find(e => e.file === rel && stripped.includes(e.text));
        if (exemption) {
          exemption.used = true;
          return;
        }
        for (const v of found) {
          violations.push(`${rel}:${i + 1}: ${v} :: ${stripped.slice(0, 120)}`);
        }
      });
    }
  }

  for (const entry of scoped.filter(e => !e.used)) {
    violations.push(`stale allowlist entry (matches no violation): ${entry.file} | ${entry.text}`);
  }

  if (violations.length > 0) {
    console.error(`theme-token-guard: ${violations.length} violation(s) in ${scanned} file(s):\n`);
    for (const v of violations) {
      console.error(`  ${v}`);
    }
    console.error(
      `\nFix by using a theme token (e.g. bg-card-bg, text-text-secondary) or var(--token).\n` +
        `Genuine exceptions go in scripts/theme-token-allowlist.txt as "path | line text :: reason".`,
    );
    process.exit(1);
  }
  console.log(`theme-token-guard: clean (${scanned} files scanned).`);
}

main();
