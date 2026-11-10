#!/usr/bin/env node
// Fails (exit 1) when shipped code names an outside host that is not on the reviewed list in
// scripts/external-hosts.allowlist.json, or names one of the hosts that list forbids.
//
// Two modes:
//   (default)   static scan of the shipped source tracked by git.
//   --runtime   checks hosts recorded while the app ran: a Playwright request log from the browser
//               (--browser-log, JSON lines with a `url`) and the server's outbound log written by
//               scripts/record-outbound-hosts.mjs (--server-log, JSON lines with a `host`).
//
// Usage: pnpm run test:external-hosts
//        pnpm run test:external-hosts --runtime --browser-log <file> --server-log <file>

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ALLOWLIST_REL_PATH = 'scripts/external-hosts.allowlist.json';
const NEXT_STEP = `Add it to ${ALLOWLIST_REL_PATH} with a reason, or remove it.`;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

// What ships: the app's own code, the installer, the sidecar and slot images, and the images'
// build files. Tests, docs and demo/ never run on a person's machine, so they are not scanned.
const SCAN_ROOTS = [
  'packages/frontend/src/',
  'packages/frontend/index.html',
  'packages/frontend/public/',
  'packages/trueforge-ui/src/',
  'packages/trueforge/src/',
  'packages/trueforge/catalog/',
  'packages/trueforge-core/src/',
  'packages/amanuensis/src/',
  'packages/aman-installer/src/',
  'installer/',
  'ops/',
  'Dockerfile',
  'packages/trueforge-core/scripts/sandbox/sandbox.Dockerfile',
  'packages/trueforge-core/scripts/sandbox-run-code/Dockerfile',
];
const EXCLUDED_SEGMENT_RE = /(^|\/)(tests?|__tests__|fixtures|__fixtures__|__mocks__)\//;
const EXCLUDED_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$|\.(md|mdx)$/;
// Lockfiles list where each package was downloaded from; the registries they name are on the
// allowlist, and their funding links are not code.
const LOCKFILE_RE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|Cargo\.lock|uv\.lock|poetry\.lock)$/;

// Names that never leave the machine or the private network, so they are not outside hosts:
// loopback, Docker service names (one label), reserved test names, and private addresses.
const LOCAL_NAMES = new Set(['localhost', 'host.docker.internal', 'example.com', 'example.net', 'example.org']);
const RESERVED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.invalid',
  '.example',
  '.test',
  '.lan',
  '.home.arpa',
  '.example.com',
  '.example.net',
  '.example.org',
];

// Text right before a URL that means the URL is loaded or connected to, not just named.
const FETCH_CONTEXTS = [
  /\b(?:fetch|new\s+URL|URL\.parse|EventSource|WebSocket|import|connect|createConnection|axios(?:\.\w+)?|got|ky|urlopen|requests\.\w+|httpx\.\w+|http\.Get)\s*\(\s*["'`]?$/,
  /\b(?:curl|wget|git\s+clone|Invoke-WebRequest|iwr)\b[^;&|\n]*$/,
  /^\s*ADD\b[^\n]*$/,
  /<(?:link|script|img|iframe|source|video|audio|embed|object)\b[^<>]*$/i,
  /\b(?:src|srcset|data)\s*=\s*\{?\s*["'`]?$/i,
  /\burl\(\s*["']?$/i,
  /@import\s+(?:url\()?\s*["']?$/i,
  /--(?:index-url|extra-index-url|registry)[=\s]+["']?$/,
];
const isFetchContext = text => FETCH_CONTEXTS.some(re => re.test(text));
// A bare hostname counts when it is handed straight to a connection: `host: 'imap.example.org'`,
// `connect('smtp.example.org', 465)`.
const BARE_HOST_RE =
  /(?:\b(?:[a-z]+_)?(?:host|hostname|servername)["']?\s*[:=]\s*|\b(?:fetch|new\s+URL|connect|createConnection)\(\s*)["'`]([a-z0-9-]+(?:\.[a-z0-9-]+)+)["'`]/gi;
const URL_RE = /\b(?:https?|wss?):\/\/([^\s'"`<>()\\,;|]+)/gi;
const PROTOCOL_RELATIVE_RE = /(?:\b(?:src|href)\s*=\s*["']|\burl\(\s*["']?)\/\/([a-z0-9.-]+)/gi;
const NOT_A_TLD = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'css', 'html', 'htm', 'svg', 'png', 'jpg', 'jpeg', 'gif',
  'webp', 'ico', 'md', 'mdx', 'txt', 'yaml', 'yml', 'toml', 'sh', 'py', 'go', 'rs', 'map', 'lock', 'xml',
  'pdf', 'zip', 'gz', 'tgz', 'wasm', 'onnx', 'bin', 'wav', 'mp3', 'ogg', 'env', 'conf', 'ini', 'log', 'db',
  'sqlite', 'tpl', 'service', 'timer', 'plist', 'desktop', 'ps1', 'exe', 'msi', 'dll', 'so', 'pem', 'crt',
  'key', 'csv', 'tsv', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'ics', 'eml', 'vue', 'scss',
]); // prettier-ignore

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

function fail(message) {
  throw new Error(`${ALLOWLIST_REL_PATH}: ${message}`);
}

function parseAllowlist(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${ALLOWLIST_REL_PATH} is not valid JSON. Fix the file so it parses.`, { cause: error });
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Array.isArray(parsed.allowed) ||
    !Array.isArray(parsed.forbidden)
  ) {
    fail('needs an "allowed" list and a "forbidden" list. Restore both keys.');
  }
  const categories = new Map();
  for (const [name, category] of Object.entries(parsed.categories ?? {})) {
    if (typeof category?.meaning !== 'string' || typeof category.link_only !== 'boolean') {
      fail(`category "${name}" needs a "meaning" and a true or false "link_only". Add both.`);
    }
    categories.set(name, { meaning: category.meaning, linkOnly: category.link_only });
  }
  if (categories.size === 0) {
    fail('needs a "categories" list. Restore it.');
  }
  const allowed = new Map();
  for (const entry of parsed.allowed) {
    const host = typeof entry?.host === 'string' ? entry.host : '';
    if (host === '' || host !== host.toLowerCase().trim()) {
      fail(
        `an allowed entry has a missing or non-lowercase host (${JSON.stringify(entry?.host)}). Write the host in lowercase.`,
      );
    }
    if (!categories.has(entry.category)) {
      fail(
        `"${host}" has category ${JSON.stringify(entry.category)}. Use one of: ${[...categories.keys()].join(', ')}.`,
      );
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      fail(`"${host}" has no reason. Say in one line why Aman names this host.`);
    }
    if (allowed.has(host)) {
      fail(`"${host}" is listed twice. Keep one entry.`);
    }
    allowed.set(host, { host, category: entry.category, reason: entry.reason });
  }
  const forbidden = new Map();
  for (const entry of parsed.forbidden) {
    const host = typeof entry?.host === 'string' ? entry.host : '';
    if (host === '' || host !== host.toLowerCase().trim()) {
      fail(
        `a forbidden entry has a missing or non-lowercase host (${JSON.stringify(entry?.host)}). Write the host in lowercase.`,
      );
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      fail(`forbidden "${host}" has no reason. Say in one line why it must never appear.`);
    }
    forbidden.set(host, { host, reason: entry.reason });
  }
  for (const host of allowed.keys()) {
    if (forbidden.has(host)) {
      fail(`"${host}" is both allowed and forbidden. Remove it from one list.`);
    }
  }
  return { categories, allowed, forbidden };
}

/**
 * The reviewed host list: `categories` (name → { meaning, linkOnly }), and `allowed`
 * (host → { host, category, reason }) and `forbidden` (host → { host, reason }) keyed by lowercase host.
 */
export function readExternalHostsAllowlist({ rootDirectory = rootDir } = {}) {
  return parseAllowlist(readFileSync(path.join(rootDirectory, ALLOWLIST_REL_PATH), 'utf8'));
}

function forbiddenEntryFor(host, forbidden) {
  for (const [name, entry] of forbidden) {
    if (host === name || host.endsWith(`.${name}`)) {
      return entry;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Host extraction
// ---------------------------------------------------------------------------

function isPrivateIPv4(host) {
  const parts = host.split('.').map(Number);
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** True for names that stay on the machine or the private network. */
export function isLocalHost(host) {
  if (LOCAL_NAMES.has(host) || !host.includes('.')) {
    return true;
  }
  if (RESERVED_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    return true;
  }
  if (isIP(host) === 4) {
    return isPrivateIPv4(host);
  }
  if (isIP(host) === 6) {
    return host === '::1' || host === '::' || /^f[cd]/.test(host) || host.startsWith('fe80');
  }
  return false;
}

/** Lowercase host from a URL authority, or undefined when it is a template or not a hostname. */
export function hostFromAuthority(authority) {
  // A template after the host (`https://api.example.org${path}`) still names the host before it.
  const hostPort = authority.split(/[/?#]|\$\{|\{\{/, 1)[0];
  const withoutUser = hostPort.includes('@') ? hostPort.slice(hostPort.lastIndexOf('@') + 1) : hostPort;
  if (/[${}<>*%[\]]/.test(withoutUser) && !/^\[[0-9a-f:]+\](:\d+)?$/i.test(withoutUser)) {
    return undefined;
  }
  let host = withoutUser.startsWith('[') ? withoutUser.slice(1, withoutUser.indexOf(']')) : withoutUser.split(':')[0];
  host = host.toLowerCase().replace(/\.+$/, '');
  if (isIP(host) !== 0) {
    return host;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) {
    return undefined;
  }
  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (host.includes('.') && !/^[a-z]{2,24}$/.test(tld)) {
    return undefined;
  }
  return host;
}

function isLinkAttribute(before) {
  return /\bhref\s*=\s*\{?\s*["'`]?$|\bhref\s*:\s*["'`]?$/i.test(before) && !/<link\b[^>]*$/i.test(before);
}

function contextOf({ lines, lineIndex, column }) {
  const before = lines[lineIndex].slice(0, column);
  if (isLinkAttribute(before)) {
    return 'link';
  }
  if (isFetchContext(before)) {
    return 'fetch';
  }
  // A URL that starts its line continues the call on the line above, e.g. `fetch(\n  'https://…'`.
  if (before.trim() === '' || /^\s*["'`]$/.test(before)) {
    const previous = lineIndex > 0 ? lines[lineIndex - 1].trimEnd() : '';
    if (isFetchContext(previous.replace(/\s*\\$/, '')) || /\b(?:fetch|new\s+URL|connect)\s*\($/.test(previous)) {
      return 'fetch';
    }
  }
  return 'reference';
}

/** Every outside host a file names: `{ line, host, context }`, context one of fetch, link, reference. */
export function extractHosts(text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  const seen = new Set();
  const add = ({ lineIndex, column, host }) => {
    if (host === undefined || isLocalHost(host)) {
      return;
    }
    const key = `${lineIndex}:${column}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    found.push({ line: lineIndex + 1, host, context: contextOf({ lines, lineIndex, column }) });
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    for (const match of line.matchAll(URL_RE)) {
      add({ lineIndex, column: match.index, host: hostFromAuthority(match[1]) });
    }
    for (const match of line.matchAll(PROTOCOL_RELATIVE_RE)) {
      const column = match.index + match[0].length - match[1].length - 2;
      add({ lineIndex, column, host: hostFromAuthority(match[1]) });
    }
    for (const match of line.matchAll(BARE_HOST_RE)) {
      const candidate = match[1].toLowerCase();
      const tld = candidate.slice(candidate.lastIndexOf('.') + 1);
      if (!NOT_A_TLD.has(tld)) {
        add({
          lineIndex,
          column: match.index + match[0].length - match[1].length - 1,
          host: hostFromAuthority(candidate),
        });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

/** Undefined when the use is fine, else the plain reason it fails. */
export function judgeHost({ host, context, allowlist }) {
  const entry = allowlist.allowed.get(host);
  // A forbidden domain covers its subdomains, except one the list allows by its exact name
  // (a service the person connects that happens to live under that domain).
  const forbidden = forbiddenEntryFor(host, allowlist.forbidden);
  if (forbidden !== undefined && (entry === undefined || forbidden.host === host)) {
    return `${host} must never appear in Aman: ${forbidden.reason} Remove it.`;
  }
  if (entry === undefined) {
    return `${host} is not on the reviewed list of outside hosts. ${NEXT_STEP}`;
  }
  const category = allowlist.categories.get(entry.category);
  if (context === 'fetch' && category?.linkOnly === true) {
    return `${host} is listed as ${entry.category} (${category.meaning}), but here it is loaded. Link to it instead of loading it, or remove it.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Static scan
// ---------------------------------------------------------------------------

function gitEnvironment() {
  const environment = { ...process.env };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_PREFIX',
    'GIT_OBJECT_DIRECTORY',
  ]) {
    Reflect.deleteProperty(environment, name);
  }
  return environment;
}

function isShipped(relPath) {
  const inRoot = SCAN_ROOTS.some(root => (root.endsWith('/') ? relPath.startsWith(root) : relPath === root));
  return inRoot && !EXCLUDED_SEGMENT_RE.test(relPath) && !EXCLUDED_FILE_RE.test(relPath) && !LOCKFILE_RE.test(relPath);
}

/** Tracked files the static scan reads, relative to the repository root. */
export function listShippedFiles({ rootDirectory = rootDir } = {}) {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: rootDirectory,
    env: gitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter(relPath => relPath !== '' && isShipped(relPath));
}

function readText(absPath) {
  let content;
  try {
    content = readFileSync(absPath);
  } catch {
    return undefined; // deleted from the working tree but still in the index
  }
  if (content.length > MAX_SCAN_BYTES || content.subarray(0, 8000).includes(0)) {
    return undefined;
  }
  return Buffer.from(content).toString('utf8');
}

export function scanExternalHosts({ rootDirectory = rootDir, files } = {}) {
  const allowlist = readExternalHostsAllowlist({ rootDirectory });
  const relPaths = files ?? listShippedFiles({ rootDirectory });
  const findings = [];
  const usedHosts = new Set();
  for (const relPath of relPaths) {
    const text = readText(path.join(rootDirectory, relPath));
    if (text === undefined) {
      continue;
    }
    for (const { line, host, context } of extractHosts(text)) {
      usedHosts.add(host);
      const reason = judgeHost({ host, context, allowlist });
      if (reason !== undefined) {
        findings.push({ file: relPath, line, host, reason });
      }
    }
  }
  const unusedHosts = [...allowlist.allowed.keys()].filter(host => !usedHosts.has(host));
  return { findings, unusedHosts, fileCount: relPaths.length };
}

// ---------------------------------------------------------------------------
// Runtime check
// ---------------------------------------------------------------------------

function readJsonLines(file) {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${file} line ${index + 1} is not JSON. Record one JSON object per line.`, { cause: error });
      }
    });
}

/** Every recorded request went to this machine, the private network, or a host the list lets Aman reach. */
export function checkRuntimeHosts({ rootDirectory = rootDir, browserLog, serverLog }) {
  const allowlist = readExternalHostsAllowlist({ rootDirectory });
  const findings = [];
  const seen = new Set();
  const consider = ({ source, host }) => {
    if (host === undefined || isLocalHost(host) || seen.has(`${source}:${host}`)) {
      return;
    }
    seen.add(`${source}:${host}`);
    // At runtime every recorded host was contacted, so a link-only entry fails here too.
    const reason = judgeHost({ host, context: 'fetch', allowlist });
    if (reason !== undefined) {
      findings.push({ file: source, line: 0, host, reason });
    }
  };
  for (const record of readJsonLines(browserLog)) {
    let host;
    try {
      const url = new URL(String(record.url));
      host = url.protocol === 'data:' || url.protocol === 'blob:' ? undefined : hostFromAuthority(url.host);
    } catch {
      host = undefined;
    }
    consider({ source: 'browser', host });
  }
  for (const record of readJsonLines(serverLog)) {
    consider({ source: 'server', host: typeof record.host === 'string' ? hostFromAuthority(record.host) : undefined });
  }
  return { findings };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function reportFindings({ findings, label }) {
  console.error(`\nExternal hosts check FAILED: ${findings.length} ${label}.\n`);
  for (const finding of findings) {
    const where = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`  ${where}  ${finding.host}\n    ${finding.reason}`);
  }
}

function parseArguments(args) {
  if (args.length === 0) {
    return { mode: 'static' };
  }
  const options = { mode: 'runtime' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--runtime') {
      continue;
    }
    if ((arg === '--browser-log' || arg === '--server-log') && args[index + 1] !== undefined) {
      options[arg === '--browser-log' ? 'browserLog' : 'serverLog'] = args[++index];
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (!args.includes('--runtime') || options.browserLog === undefined || options.serverLog === undefined) {
    throw new Error('the runtime check needs --runtime --browser-log <file> --server-log <file>');
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === 'runtime') {
    const { findings } = checkRuntimeHosts({ rootDirectory: rootDir, ...options });
    if (findings.length > 0) {
      reportFindings({ findings, label: 'outside host(s) contacted while the app ran' });
      process.exitCode = 1;
      return;
    }
    console.log('External hosts check passed: every request while the app ran stayed on the reviewed list.');
    return;
  }
  const { findings, unusedHosts, fileCount } = scanExternalHosts({ rootDirectory: rootDir });
  for (const host of unusedHosts) {
    findings.push({
      file: ALLOWLIST_REL_PATH,
      line: 0,
      host,
      reason: `${host} no longer appears in shipped code. Remove its entry so the list stays the real list.`,
    });
  }
  if (findings.length > 0) {
    reportFindings({ findings, label: 'problem(s) with outside hosts in shipped code' });
    process.exitCode = 1;
    return;
  }
  console.log(`External hosts check passed: ${fileCount} shipped file(s) name only reviewed outside hosts.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`External hosts check FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
