#!/usr/bin/env node
// Fails (exit 1) if any file TRACKED by git looks like private material:
// private keys, database/dump files, high-signal credential strings, or a
// real (non-example/test) .env file with populated values.
//
// Scope is deliberately narrow: the default scans `git ls-files -z`, while
// `--tree` scans blobs tracked by that commit. Untracked and ignored files are
// someone's local business, not CI's — the danger this guards against is
// committing them, not merely having them on disk.
//
// Usage: pnpm run test:private-data --tree <commit-oid>

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_REL_PATH = 'scripts/private-data-allowlist.txt';

// Files at or under this size get their content scanned. Above it we still
// apply filename rules, but skip reading the bytes for speed — a git repo's
// large tracked files are overwhelmingly build assets / lockfiles / images,
// not something that hides a secret only past the first 2 MB.
const MAX_CONTENT_SCAN_BYTES = 2 * 1024 * 1024;
const TREE_CONTENT_BATCH_BYTES = 16 * 1024 * 1024;
const GIT_REPOSITORY_ENV_NAMES = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_WORK_TREE',
];

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

// (a) Private key material — filename.
const PRIVATE_KEY_FILENAME_RE = /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.[^/]+)?$|\.(pem|key|pfx|p12)$/i;

// (a) Private key material — content banners.
//
// Assembled from parts rather than written out, so this file does not match its
// own rule. Spelling them literally made the scanner fail on itself as soon as
// it was committed, and the fix for that must not be an allowlist entry: a
// detector exempt from its own check is one nobody can trust, and a real key
// pasted into this file would then pass.
const KEY_BANNER_KINDS = ['OPENSSH ', 'RSA ', 'EC ', 'DSA ', 'PGP ', ''];
const KEY_BANNERS = KEY_BANNER_KINDS.map(kind => `BEGIN ${kind}PRIVATE KEY`);

// (b) Databases / dumps — filename.
const DB_DUMP_FILENAME_RE = /\.(sqlite3?|sqlite-shm|sqlite-wal|db|mdb|bundle)$/i;

// (c) Credential-shaped content. Each pattern requires enough trailing
// entropy/length that a placeholder like `dtn_...` or `dtn_secret` (both of
// which are tracked today, as UI placeholder text / test fixtures) cannot
// match — only something that looks like a real issued token can.
const CREDENTIAL_PATTERNS = [
  { name: 'Daytona/Nightona API key (dtn_...)', re: /\bdtn_[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token (ghp_/gho_/ghu_/ghs_/ghr_...)', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { name: 'OpenAI-style secret key (sk-...)', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'AWS access key ID (AKIA...)', re: /\bAKIA[A-Z0-9]{16}\b/ },
  { name: 'Slack token (xox[baprs]-...)', re: /\bxox[baprs]-[A-Za-z0-9-]{6,}/ },
];

// (d) .env files. Names ending in one of these are documentation/fixtures by
// convention in this repo (see .gitignore) and are always allowed, whatever
// their content.
const ENV_CANDIDATE_RE = /(^|\/)\.env(\.[^/]*)?$/i;
const ENV_ALLOWED_NAME_RE = /^\.env\.(example|sample|template|test)(\.[^/]*)?$/i;

// Values that read as placeholders rather than real secrets, for the .env
// files that aren't allowed by name outright.
const PLACEHOLDER_VALUE_RE =
  /^(<.*>|\.{3}|x{3,}|xxx.*|changeme|change_me|your[-_].*|todo.*|fixme.*|replace.*|placeholder.*|dummy.*|sample.*|example.*|redacted.*|fake.*|n\/a|none|null)$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gitEnvironment() {
  const environment = { ...process.env };
  for (const name of GIT_REPOSITORY_ENV_NAMES) {
    Reflect.deleteProperty(environment, name);
  }
  return environment;
}

function resolveTreeish({ rootDirectory, treeish }) {
  if (treeish === undefined) {
    return undefined;
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(treeish)) {
    throw new Error('--tree must be a full Git object ID');
  }
  return execFileSync('git', ['rev-parse', '--verify', `${treeish}^{commit}`], {
    cwd: rootDirectory,
    encoding: 'utf8',
    env: gitEnvironment(),
  }).trim();
}

function splitNullTerminatedRecords({ output, command }) {
  const records = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0) {
      throw new Error(`${command} returned an unterminated record`);
    }
    if (end > start) {
      records.push(output.subarray(start, end));
    }
    start = end + 1;
  }
  return records;
}

function decodeGitPath(pathBytes) {
  const relPath = pathBytes.toString('utf8');
  if (!Buffer.from(relPath, 'utf8').equals(pathBytes)) {
    throw new Error('Git tree contains a non-UTF-8 pathname; refusing to scan an ambiguous tree');
  }
  return relPath;
}

function listTrackedFiles({ rootDirectory, treeish }) {
  if (treeish === undefined) {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: rootDirectory,
      env: gitEnvironment(),
      maxBuffer: 1024 * 1024 * 64,
    });
    return splitNullTerminatedRecords({ output: out, command: 'git ls-files -z' }).map(entry => ({
      relPath: decodeGitPath(entry).split(path.sep).join('/'), // normalize on Windows
    }));
  }

  const out = execFileSync('git', ['ls-tree', '-r', '-z', '-l', '--full-tree', treeish], {
    cwd: rootDirectory,
    env: gitEnvironment(),
    maxBuffer: 1024 * 1024 * 64,
  });
  const trackedFiles = [];
  const seenRelPaths = new Set();
  for (const record of splitNullTerminatedRecords({ output: out, command: 'git ls-tree -z' })) {
    const separator = record.indexOf(0x09);
    if (separator < 0) {
      throw new Error('malformed git ls-tree record');
    }
    const metadata = record.subarray(0, separator).toString('ascii');
    const [mode, type, objectId, sizeText] = metadata.split(/\s+/u);
    const size = sizeText === '-' ? undefined : Number.parseInt(sizeText, 10);
    if (!mode || !type || !objectId || (size !== undefined && !Number.isSafeInteger(size))) {
      throw new Error(`malformed git ls-tree metadata: ${metadata}`);
    }
    const relPath = decodeGitPath(record.subarray(separator + 1));
    if (seenRelPaths.has(relPath)) {
      throw new Error(`Git tree contains a duplicate pathname (${JSON.stringify(relPath)}); refusing to scan it`);
    }
    seenRelPaths.add(relPath);
    trackedFiles.push({
      relPath,
      type,
      objectId,
      size,
    });
  }
  return trackedFiles;
}

function readTreeBlobBatch({ rootDirectory, entries }) {
  const expectedBytes = entries.reduce((total, entry) => total + (entry.size ?? 0), 0);
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: rootDirectory,
    env: gitEnvironment(),
    input: `${entries.map(entry => entry.objectId).join('\n')}\n`,
    maxBuffer: Math.max(1024 * 1024, expectedBytes + entries.length * 128),
  });
  const contents = [];
  let cursor = 0;
  for (const entry of entries) {
    const headerEnd = out.indexOf(0x0a, cursor);
    if (headerEnd < 0) {
      throw new Error(`git cat-file omitted a header for ${entry.relPath}`);
    }
    const [objectId, type, sizeText] = out.subarray(cursor, headerEnd).toString('ascii').split(' ');
    const size = Number.parseInt(sizeText, 10);
    if (objectId !== entry.objectId || type !== 'blob' || !Number.isSafeInteger(size)) {
      throw new Error(`git cat-file returned invalid metadata for ${entry.relPath}`);
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= out.length || out[contentEnd] !== 0x0a) {
      throw new Error(`git cat-file returned truncated content for ${entry.relPath}`);
    }
    contents.push(out.subarray(contentStart, contentEnd));
    cursor = contentEnd + 1;
  }
  return contents;
}

function readTreeContents({ rootDirectory, trackedFiles }) {
  const contents = new Map();
  let batch = [];
  let batchBytes = 0;

  const flush = () => {
    if (batch.length === 0) {
      return;
    }
    const blobs = readTreeBlobBatch({ rootDirectory, entries: batch });
    for (let index = 0; index < batch.length; index++) {
      contents.set(batch[index].relPath, blobs[index]);
    }
    batch = [];
    batchBytes = 0;
  };

  for (const entry of trackedFiles) {
    if (entry.type !== 'blob' || entry.size === undefined || entry.size > MAX_CONTENT_SCAN_BYTES) {
      continue;
    }
    if (batch.length > 0 && batchBytes + entry.size > TREE_CONTENT_BATCH_BYTES) {
      flush();
    }
    batch.push(entry);
    batchBytes += entry.size;
  }
  flush();
  return contents;
}

function readAllowlist({ rootDirectory, treeContents }) {
  let raw;
  if (treeContents !== undefined) {
    const content = treeContents.get(ALLOWLIST_REL_PATH);
    if (content === undefined) {
      return [];
    }
    raw = content.toString('utf8');
  } else {
    try {
      raw = readFileSync(path.join(rootDirectory, ALLOWLIST_REL_PATH), 'utf8');
    } catch {
      return [];
    }
  }
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .map(pattern => ({ pattern, re: globToRegExp(pattern) }));
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') {
          i++;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchAllowlistEntry(relPath, allowlist) {
  return allowlist.find(entry => entry.re.test(relPath) || entry.pattern === relPath);
}

// Quick sniff for binary content: a NUL byte in the first 8 KB. Cheap, and
// avoids running text patterns over images/binaries where they'd be noise.
function looksBinary(absPath) {
  let fd;
  try {
    fd = openSync(absPath, 'r');
    const buf = Buffer.alloc(8000);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed / gone */
      }
    }
  }
}

function looksBinaryBuffer(content) {
  const sniffLength = Math.min(content.length, 8000);
  for (let index = 0; index < sniffLength; index++) {
    if (content[index] === 0) {
      return true;
    }
  }
  return false;
}

function findKeyBanner(text) {
  return KEY_BANNERS.find(banner => text.includes(banner));
}

// Returns { flagged, key } — flagged when at least one KEY=VALUE line has a
// non-empty, non-placeholder value.
function realEnvValueCheck(text) {
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!value) {
      continue;
    }
    if (PLACEHOLDER_VALUE_RE.test(value)) {
      continue;
    }
    return { flagged: true, key: match[1] };
  }
  return { flagged: false };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export function scanPrivateData({ rootDirectory = rootDir, treeish } = {}) {
  const resolvedTreeish = resolveTreeish({ rootDirectory, treeish });
  const trackedFiles = listTrackedFiles({ rootDirectory, treeish: resolvedTreeish });
  const treeContents = resolvedTreeish === undefined ? undefined : readTreeContents({ rootDirectory, trackedFiles });
  const allowlist = readAllowlist({ rootDirectory, treeContents });
  const usedAllowlistEntries = new Set();
  const findings = [];

  for (const trackedFile of trackedFiles) {
    const { relPath } = trackedFile;
    const reasons = [];
    const basename = path.posix.basename(relPath);

    if (PRIVATE_KEY_FILENAME_RE.test(relPath)) {
      reasons.push('filename matches private key material (id_rsa/id_ed25519/id_ecdsa/*.pem/*.key/*.pfx/*.p12)');
    }
    if (DB_DUMP_FILENAME_RE.test(relPath)) {
      reasons.push('filename matches a database/dump pattern (*.sqlite/*.sqlite3/*.db/*.mdb/*.bundle/etc.)');
    }

    const isEnvCandidate = ENV_CANDIDATE_RE.test(relPath);
    const isEnvAllowedByName = ENV_ALLOWED_NAME_RE.test(basename);
    let skipContent;
    let content;

    if (treeContents !== undefined) {
      content = treeContents.get(relPath);
      const readableBlob = trackedFile.type === 'blob' && trackedFile.size !== undefined && content !== undefined;
      skipContent = !readableBlob || trackedFile.size > MAX_CONTENT_SCAN_BYTES || looksBinaryBuffer(content);
    } else {
      const absPath = path.join(rootDirectory, relPath);
      let size = 0;
      let statOk = true;
      try {
        size = statSync(absPath).size;
      } catch {
        statOk = false; // gone from the working tree (rare race); rely on filename rules only
      }
      skipContent = !statOk || size > MAX_CONTENT_SCAN_BYTES || looksBinary(absPath);
      if (!skipContent) {
        try {
          content = readFileSync(absPath);
        } catch {
          content = undefined;
        }
      }
    }

    if (!skipContent && content !== undefined) {
      const text = content.toString('latin1'); // 1:1 byte mapping, no decode errors
      const banner = findKeyBanner(text);
      if (banner) {
        reasons.push(`file content contains a private key banner ("${banner}")`);
      }

      for (const credential of CREDENTIAL_PATTERNS) {
        if (credential.re.test(text)) {
          reasons.push(`file content matches ${credential.name}`);
        }
      }

      if (isEnvCandidate && !isEnvAllowedByName) {
        const envResult = realEnvValueCheck(text);
        if (envResult.flagged) {
          reasons.push(
            `real .env file with a populated value for "${envResult.key}" (only .env.example/.env.sample/.env.template/.env.test names, or files with placeholder-only values, are allowed)`,
          );
        }
      }
    } else if (isEnvCandidate && !isEnvAllowedByName) {
      // Can't verify placeholder-only content on a large/binary env-like file — flag it
      // conservatively rather than silently skip it.
      reasons.push(
        'env-like filename outside the allowed example/sample/template/test set, and too large or binary to verify its values are placeholders',
      );
    }

    if (reasons.length === 0) {
      continue;
    }

    const allowlistEntry = matchAllowlistEntry(relPath, allowlist);
    if (allowlistEntry) {
      usedAllowlistEntries.add(allowlistEntry.pattern);
      continue;
    }

    findings.push({ file: relPath, reasons });
  }

  return { findings, trackedFileCount: trackedFiles.length, usedAllowlistEntries };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function reportScan({ rootDirectory, result }) {
  if (result.usedAllowlistEntries.size > 0) {
    console.log(`Allowlist entries used from ${ALLOWLIST_REL_PATH}:`);
    for (const pattern of result.usedAllowlistEntries) {
      console.log(`  - ${pattern}`);
    }
  }

  if (result.findings.length > 0) {
    console.error(
      `\nPrivate data scan FAILED: ${result.findings.length} tracked file(s) look like private material.\n`,
    );
    for (const finding of result.findings) {
      console.error(`  ${finding.file}`);
      for (const reason of finding.reasons) {
        console.error(`    - ${reason}`);
      }
    }
    console.error(
      `\nIf any of these are genuine false positives, add the exact path or a glob to ${path.relative(
        rootDirectory,
        path.join(rootDirectory, ALLOWLIST_REL_PATH),
      )} (one per line, # comments allowed) — otherwise remove the file from git and rotate any exposed credential.`,
    );
    return false;
  }

  console.log(
    `Private data scan passed: ${result.trackedFileCount} tracked file(s) checked, no private material found.`,
  );
  return true;
}

function parseArguments(args) {
  if (args.length === 0) {
    return {};
  }
  if (args.length === 2 && args[0] === '--tree') {
    return { treeish: args[1] };
  }
  throw new Error('usage: node scripts/check-no-private-data.mjs [--tree <commit-oid>]');
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = scanPrivateData({ rootDirectory: rootDir, ...options });
  if (!reportScan({ rootDirectory: rootDir, result })) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`Private data scan FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
