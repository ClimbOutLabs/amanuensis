// Marketplace skills do not say which sites they reach, so the host reads the skill's files itself
// before anyone approves it. This never runs the skill's code. A clever author can still hide an
// address; the network gateway stays the real wall, and this scan's job is to warn up front.

/** One file of a skill, as fetched at one exact commit. `path` is relative to the skill folder. */
export interface SkillFile {
  path: string;
  bytes: Uint8Array;
}

/**
 * Where in the skill a site was found, which says how it is used. `reference` is an address in a
 * supporting document, such as a link in a guide: it is kept for the record but not put on the
 * list the person approves, since the skill only mentions it. Anything the skill really tries
 * there is still refused and asked about when it runs.
 */
export type SkillSiteSource = 'script' | 'config' | 'instructions' | 'reference' | 'dependency';

export interface SkillSiteFinding {
  host: string;
  file: string;
  line: number;
  source: SkillSiteSource;
}

/** A way the skill reaches the network that cannot be read ahead of time. */
export type SkillSiteUnknownKind =
  'built_address' | 'encoded_text' | 'runs_downloaded_code' | 'raw_socket' | 'ip_address' | 'unreadable_file';

export interface SkillSiteUnknown {
  kind: SkillSiteUnknownKind;
  file: string;
  line: number;
}

export interface SkillSiteScan {
  /** The sites the skill reaches for, sorted, each once: every finding except `reference` ones. */
  hosts: string[];
  findings: SkillSiteFinding[];
  unknown: SkillSiteUnknown[];
}

const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 20_000;

type FileKind = 'script' | 'config' | 'instructions' | 'text' | 'media' | 'legal' | 'other';

const SCRIPT_EXTENSIONS = new Set([
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.jsx',
  '.tsx',
  '.sh',
  '.bash',
  '.zsh',
  '.rb',
  '.go',
  '.php',
  '.pl',
  '.ps1',
  '.lua',
  '.r',
  '.java',
  '.kt',
  '.rs',
  '.swift',
  '.cs',
]);
const CONFIG_EXTENSIONS = new Set([
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.xml',
  '.properties',
]);
const TEXT_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.html', '.htm', '.csv', '.tsv']);
// Pictures, fonts and documents cannot carry runnable code the sandbox would run on its own.
const MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.svg',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.wav',
  '.ogg',
  '.mp4',
  '.webm',
  '.docx',
  '.xlsx',
  '.pptx',
]);
const CONFIG_FILE_NAMES = new Set(['requirements.txt', 'pipfile', 'gemfile', 'dockerfile', 'makefile', '.env.example']);

// Licence and history files name sites as part of their legal text, never as something to call.
const LEGAL_FILE = /^(?:license|licence|copying|notice|authors|changelog|third_party_notices)(?:[._-].*)?$/u;

function fileKind(path: string): FileKind {
  const base = (path.split('/').pop() ?? path).toLowerCase();
  if (path.toLowerCase() === 'skill.md') {
    return 'instructions';
  }
  if (LEGAL_FILE.test(base)) {
    return 'legal';
  }
  if (CONFIG_FILE_NAMES.has(base) || base.startsWith('.env')) {
    return 'config';
  }
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot) : '';
  if (SCRIPT_EXTENSIONS.has(extension)) {
    return 'script';
  }
  if (CONFIG_EXTENSIONS.has(extension)) {
    return 'config';
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return 'text';
  }
  if (MEDIA_EXTENSIONS.has(extension)) {
    return 'media';
  }
  return 'other';
}

/** Lowercase exact host name with at least one dot, the shape the gateway matches. */
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/u;

// Names used in examples and tests, or that never leave the machine. Contacting them is not a
// reason to warn the person.
// XML and schema name spaces look like addresses but are only labels inside documents.
const QUIET_HOSTS = new Set([
  'localhost',
  'example.com',
  'example.org',
  'example.net',
  'host.docker.internal',
  'www.w3.org',
  'schemas.openxmlformats.org',
  'schemas.microsoft.com',
  'purl.org',
  'dublincore.org',
  'ns.adobe.com',
  'xmlns.com',
  'json-schema.org',
]);
const QUIET_SUFFIXES = ['.example', '.test', '.invalid', '.localhost', '.local', '.internal', '.example.com'];

function isQuietHost(host: string): boolean {
  return QUIET_HOSTS.has(host) || QUIET_SUFFIXES.some(suffix => host.endsWith(suffix));
}

function isQuietAddress(address: string): boolean {
  return address === '0.0.0.0' || address.startsWith('127.');
}

// A quoted bare name like "api.inbrief.info" counts as a site only with one of these endings, so
// "config.json", "os.path" or "requests.get" are not read as sites. Full addresses with a scheme
// take any ending.
const BARE_NAME_ENDINGS = new Set([
  'com',
  'net',
  'org',
  'io',
  'ai',
  'dev',
  'app',
  'info',
  'co',
  'me',
  'us',
  'uk',
  'de',
  'fr',
  'nl',
  'eu',
  'ca',
  'au',
  'in',
  'jp',
  'cn',
  'ru',
  'br',
  'es',
  'it',
  'ch',
  'se',
  'no',
  'xyz',
  'site',
  'online',
  'cloud',
  'news',
  'tech',
  'gov',
  'edu',
  'biz',
  'tv',
  'gg',
  'so',
  'sh',
  'to',
  'ly',
  'cc',
  'link',
  'top',
  'run',
  'page',
  'workers',
]);

// An address written as an XML name space label, as in xmlns:script="http://...".
const XML_NAME_SPACE = /\bxmlns(?::[\w.-]+)?\s*=\s*["']$/u;
const URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/([^\s/'"`<>()[\]{}\\,;|]+)/giu;
const QUOTED_PATTERN = /(["'`])([A-Za-z0-9.-]{4,253})\1/gu;

/** The host part of an address's authority, without user, password or port; undefined when it is built at run time. */
function authorityHost(authority: string): { host: string } | { built: true } | { ip: string } | undefined {
  const withoutUser = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  const name = (withoutUser.split(':')[0] ?? '').toLowerCase();
  if (name === 'localhost' || isQuietAddress(name)) {
    return undefined;
  }
  if (/[{}$%<>]/u.test(withoutUser) || withoutUser.length === 0) {
    return { built: true };
  }
  if (withoutUser.startsWith('[')) {
    return { ip: withoutUser };
  }
  const host = withoutUser.replace(/:\d*$/u, '').replace(/\.$/u, '').toLowerCase();
  if (IPV4.test(host)) {
    return { ip: host };
  }
  if (host === 'localhost') {
    return undefined;
  }
  return HOST_NAME.test(host) ? { host } : undefined;
}

// Known client packages that talk to one fixed service. A package not listed here tells us nothing
// on its own: it is the address it is given that matters, and the scripts are read for that.
const PACKAGE_HOSTS: ReadonlyMap<string, string> = new Map([
  ['openai', 'api.openai.com'],
  ['anthropic', 'api.anthropic.com'],
  ['@anthropic-ai/sdk', 'api.anthropic.com'],
  ['google-generativeai', 'generativelanguage.googleapis.com'],
  ['google-genai', 'generativelanguage.googleapis.com'],
  ['@google/generative-ai', 'generativelanguage.googleapis.com'],
  ['mistralai', 'api.mistral.ai'],
  ['@mistralai/mistralai', 'api.mistral.ai'],
  ['cohere', 'api.cohere.com'],
  ['cohere-ai', 'api.cohere.com'],
  ['groq', 'api.groq.com'],
  ['groq-sdk', 'api.groq.com'],
  ['replicate', 'api.replicate.com'],
  ['tavily-python', 'api.tavily.com'],
  ['@tavily/core', 'api.tavily.com'],
  ['newsapi-python', 'newsapi.org'],
  ['tweepy', 'api.twitter.com'],
  ['slack-sdk', 'slack.com'],
  ['slack_sdk', 'slack.com'],
  ['@slack/web-api', 'slack.com'],
  ['stripe', 'api.stripe.com'],
  ['twilio', 'api.twilio.com'],
  ['sendgrid', 'api.sendgrid.com'],
  ['@sendgrid/mail', 'api.sendgrid.com'],
  ['resend', 'api.resend.com'],
  ['pinecone', 'api.pinecone.io'],
  ['pinecone-client', 'api.pinecone.io'],
  ['@pinecone-database/pinecone', 'api.pinecone.io'],
  ['notion-client', 'api.notion.com'],
  ['@notionhq/client', 'api.notion.com'],
  ['pygithub', 'api.github.com'],
  ['@octokit/rest', 'api.github.com'],
  ['yfinance', 'query1.finance.yahoo.com'],
  ['wikipedia', 'en.wikipedia.org'],
  ['praw', 'oauth.reddit.com'],
]);

function packageHost(name: string): string | undefined {
  return (
    PACKAGE_HOSTS.get(name.trim().toLowerCase().replace(/_/gu, '-')) ?? PACKAGE_HOSTS.get(name.trim().toLowerCase())
  );
}

// Python module names differ from their package names for a few clients.
const PYTHON_MODULE_PACKAGES: ReadonlyMap<string, string> = new Map([
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['google.generativeai', 'google-generativeai'],
  ['google.genai', 'google-genai'],
  ['mistralai', 'mistralai'],
  ['cohere', 'cohere'],
  ['groq', 'groq'],
  ['replicate', 'replicate'],
  ['tavily', 'tavily-python'],
  ['newsapi', 'newsapi-python'],
  ['tweepy', 'tweepy'],
  ['slack_sdk', 'slack-sdk'],
  ['stripe', 'stripe'],
  ['twilio', 'twilio'],
  ['sendgrid', 'sendgrid'],
  ['resend', 'resend'],
  ['pinecone', 'pinecone'],
  ['notion_client', 'notion-client'],
  ['github', 'pygithub'],
  ['yfinance', 'yfinance'],
  ['wikipedia', 'wikipedia'],
  ['praw', 'praw'],
]);

// Calls that reach the network. When one of these is on a line with no written-out address, the
// address is built at run time.
const NETWORK_CALL =
  /\b(?:requests|httpx|aiohttp|session|client)\.(?:get|post|put|patch|delete|head|request|stream)\s*\(|\burlopen\s*\(|\burllib\.request\.Request\s*\(|\bhttp\.client\.HTTPS?Connection\s*\(|\bfetch\s*\(|\baxios(?:\.(?:get|post|put|patch|delete|request))?\s*\(|\bgot\s*\(|\bhttps?\.(?:get|request)\s*\(|\bWebSocket\s*\(|\bwebsockets?\.connect\s*\(|(?:^|[\s;|&(])(?:curl|wget|nc|ncat|telnet|ssh|scp|rsync)\s/u;
const BUILT_ADDRESS =
  /(["'`])(?:https?|wss?):\/\/\1\s*\+|f["'](?:https?|wss?):\/\/\{|`(?:https?|wss?):\/\/\$\{|["'](?:https?|wss?):\/\/["']\s*\.format|["'](?:https?|wss?):\/\/%s|(?:https?|wss?):\/\/\$\{?[A-Za-z_]|\b(?:os\.environ|os\.getenv|process\.env)\b[^\n]*(?:URL|URI|HOST|ENDPOINT|BASE|SERVER|API)/u;
const ENCODED_TEXT =
  /\bb(?:64|32|16|85)decode\s*\(|\bbase64\.(?:b64|urlsafe_b64|standard_b64)decode\s*\(|\batob\s*\(|Buffer\.from\s*\([^)]*['"](?:base64|hex)['"]|\bbytes\.fromhex\s*\(|\bString\.fromCharCode\s*\(|\bcodecs\.decode\s*\(|\bbinascii\.(?:unhexlify|a2b_)|\bbase64\s+(?:-d|--decode)\b|\bxxd\s+-r\b/u;
const RUNS_DOWNLOADED_CODE =
  /(?<![.\w])(?:eval|exec)\s*\(|\bnew\s+Function\s*\(|\b__import__\s*\(|\bimportlib\.import_module\s*\(|\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\|\s*python3?\b|\bpip3?\s+install\b|\bnpm\s+(?:install|i)\b|\bnpx\s|\bsubprocess\.[A-Za-z_]+\s*\([^)]*\bpip\b|\bcompile\s*\([^)]*['"]exec['"]/u;
const RAW_SOCKET =
  /\bsocket\.(?:socket|create_connection)\s*\(|\bnet\.(?:connect|createConnection|Socket)\s*\(|\btls\.connect\s*\(|\bdgram\.createSocket\s*\(|\bdns\.(?:resolve|lookup)|\bsocket\.getaddrinfo\s*\(|\/dev\/tcp\//u;

// A socket to this machine or a local file socket never leaves the sandbox.
const LOCAL_SOCKET = /\bAF_UNIX\b|["'](?:localhost|127\.0\.0\.1|::1)["']/u;

const LONG_BASE64 = /["'`]([A-Za-z0-9+/_-]{16,}={0,2})["'`]/gu;

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function decodeBase64(value: string): string | undefined {
  const text = Buffer.from(value.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64').toString('utf-8');
  return /^[\x20-\x7e\s]+$/u.test(text) ? text : undefined;
}

class ScanCollector {
  readonly findings: SkillSiteFinding[] = [];
  readonly unknown: SkillSiteUnknown[] = [];
  readonly #findingKeys = new Set<string>();
  readonly #unknownKeys = new Set<string>();

  addHost(finding: SkillSiteFinding): void {
    if (isQuietHost(finding.host)) {
      return;
    }
    const key = `${finding.host}\n${finding.file}\n${String(finding.line)}`;
    if (!this.#findingKeys.has(key)) {
      this.#findingKeys.add(key);
      this.findings.push(finding);
    }
  }

  addUnknown(entry: SkillSiteUnknown): void {
    const key = `${entry.kind}\n${entry.file}\n${String(entry.line)}`;
    if (!this.#unknownKeys.has(key)) {
      this.#unknownKeys.add(key);
      this.unknown.push(entry);
    }
  }

  /** Reads every written-out address on the line. Returns whether any was found. */
  addAddresses(input: { text: string; file: string; line: number; source: SkillSiteSource }): boolean {
    let found = false;
    for (const match of input.text.matchAll(URL_PATTERN)) {
      if (XML_NAME_SPACE.test(input.text.slice(0, match.index))) {
        continue;
      }
      const parsed = authorityHost(match[1] ?? '');
      if (parsed === undefined) {
        continue;
      }
      found = true;
      if ('host' in parsed) {
        this.addHost({ host: parsed.host, file: input.file, line: input.line, source: input.source });
      } else if (input.source === 'reference') {
        // A supporting document only mentions an address, so how it is written warns of nothing.
        continue;
      } else if ('ip' in parsed) {
        if (!isQuietAddress(parsed.ip)) {
          this.addUnknown({ kind: 'ip_address', file: input.file, line: input.line });
        }
      } else {
        this.addUnknown({ kind: 'built_address', file: input.file, line: input.line });
      }
    }
    return found;
  }
}

function scanCodeLine(input: {
  collector: ScanCollector;
  text: string;
  file: string;
  line: number;
  source: SkillSiteSource;
}): void {
  const { collector, text, file, line, source } = input;
  let hasAddress = collector.addAddresses({ text, file, line, source });
  for (const match of text.matchAll(QUOTED_PATTERN)) {
    const value = (match[2] ?? '').toLowerCase();
    if (IPV4.test(value)) {
      if (!isQuietAddress(value)) {
        collector.addUnknown({ kind: 'ip_address', file, line });
      }
      continue;
    }
    const ending = value.split('.').pop() ?? '';
    if (HOST_NAME.test(value) && BARE_NAME_ENDINGS.has(ending)) {
      collector.addHost({ host: value, file, line, source });
      hasAddress = true;
    }
  }
  for (const match of text.matchAll(LONG_BASE64)) {
    const decoded = decodeBase64(match[1] ?? '');
    if (decoded !== undefined && /(?:https?|wss?):\/\//iu.test(decoded)) {
      collector.addAddresses({ text: decoded, file, line, source });
      collector.addUnknown({ kind: 'encoded_text', file, line });
    }
  }
  if (source !== 'script') {
    return;
  }
  if (BUILT_ADDRESS.test(text) || (NETWORK_CALL.test(text) && !hasAddress)) {
    collector.addUnknown({ kind: 'built_address', file, line });
  }
  if (ENCODED_TEXT.test(text)) {
    collector.addUnknown({ kind: 'encoded_text', file, line });
  }
  if (RUNS_DOWNLOADED_CODE.test(text)) {
    collector.addUnknown({ kind: 'runs_downloaded_code', file, line });
  }
  if (RAW_SOCKET.test(text) && !LOCAL_SOCKET.test(text)) {
    collector.addUnknown({ kind: 'raw_socket', file, line });
  }
}

function addPackage(input: { collector: ScanCollector; name: string; file: string; line: number }): void {
  const host = packageHost(input.name);
  if (host !== undefined) {
    input.collector.addHost({ host, file: input.file, line: input.line, source: 'dependency' });
  }
}

const PYTHON_IMPORT =
  /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\b|import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*))/u;
const JS_IMPORT = /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gu;

function scanImports(input: { collector: ScanCollector; text: string; file: string; line: number }): void {
  const python = PYTHON_IMPORT.exec(input.text);
  if (python !== null) {
    const names = (python[1] ?? python[2] ?? '').split(',').map(name => name.trim());
    for (const name of names) {
      const parts = name.split('.');
      const candidates = [parts.slice(0, 2).join('.'), parts[0] ?? ''];
      const pkg = candidates.map(candidate => PYTHON_MODULE_PACKAGES.get(candidate)).find(value => value !== undefined);
      if (pkg !== undefined) {
        addPackage({ collector: input.collector, name: pkg, file: input.file, line: input.line });
      }
    }
  }
  for (const match of input.text.matchAll(JS_IMPORT)) {
    addPackage({ collector: input.collector, name: match[1] ?? '', file: input.file, line: input.line });
  }
}

/** Reads the dependency lists a skill can ship: requirements files, package.json and pyproject.toml. */
function scanManifest(input: { collector: ScanCollector; path: string; text: string }): void {
  const base = (input.path.split('/').pop() ?? '').toLowerCase();
  const lines = input.text.split(/\r?\n/u);
  if (/^requirements.*\.txt$/u.test(base) || base === 'pipfile') {
    lines.forEach((raw, index) => {
      const name = /^\s*([A-Za-z0-9_.-]+)/u.exec(raw.replace(/#.*/u, ''))?.[1];
      if (name !== undefined) {
        addPackage({ collector: input.collector, name, file: input.path, line: index + 1 });
      }
    });
    return;
  }
  if (base === 'package.json') {
    lines.forEach((raw, index) => {
      const name = /^\s*"(@?[A-Za-z0-9_./-]+)"\s*:\s*"[^"]*"\s*,?\s*$/u.exec(raw)?.[1];
      if (name !== undefined) {
        addPackage({ collector: input.collector, name, file: input.path, line: index + 1 });
      }
    });
    return;
  }
  if (base === 'pyproject.toml') {
    lines.forEach((raw, index) => {
      for (const match of raw.matchAll(/["']([A-Za-z0-9_.-]+)\s*(?:[<>=!~;[\s][^"']*)?["']/gu)) {
        addPackage({ collector: input.collector, name: match[1] ?? '', file: input.path, line: index + 1 });
      }
      const key = /^\s*([A-Za-z0-9_-]+)\s*=/u.exec(raw)?.[1];
      if (key !== undefined) {
        addPackage({ collector: input.collector, name: key, file: input.path, line: index + 1 });
      }
    });
  }
}

/**
 * Finds the sites a skill's files reach for, and the ways it reaches the network that cannot be
 * read ahead of time. Scripts are read for written-out addresses, quoted site names, client
 * packages and network calls; config files for addresses and site names; instructions and other
 * text for addresses only, where only SKILL.md counts towards the sites to approve. A file that cannot be read as text and is not a picture or document
 * is reported, because it could hold code the scan cannot see.
 */
export function scanSkillSites(files: readonly SkillFile[]): SkillSiteScan {
  const collector = new ScanCollector();
  for (const file of files) {
    const kind = fileKind(file.path);
    if (kind === 'media' || kind === 'legal') {
      continue;
    }
    const text = file.bytes.byteLength > MAX_TEXT_FILE_BYTES ? undefined : decodeText(file.bytes);
    if (text === undefined) {
      collector.addUnknown({ kind: 'unreadable_file', file: file.path, line: 0 });
      continue;
    }
    // A file with no known ending but a #! line is a script.
    const effective: FileKind = kind === 'other' && text.startsWith('#!') ? 'script' : kind;
    if (effective === 'config') {
      scanManifest({ collector, path: file.path, text });
    }
    const lines = text.split(/\r?\n/u);
    lines.forEach((raw, index) => {
      const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;
      const lineNumber = index + 1;
      if (effective === 'script') {
        if (isCommentLine(line)) {
          return;
        }
        scanImports({ collector, text: line, file: file.path, line: lineNumber });
        scanCodeLine({ collector, text: line, file: file.path, line: lineNumber, source: 'script' });
      } else if (effective === 'config') {
        scanCodeLine({ collector, text: line, file: file.path, line: lineNumber, source: 'config' });
      } else {
        const source = effective === 'instructions' ? 'instructions' : 'reference';
        collector.addAddresses({ text: line, file: file.path, line: lineNumber, source });
      }
    });
  }
  const hosts = [
    ...new Set(collector.findings.filter(finding => finding.source !== 'reference').map(finding => finding.host)),
  ].sort();
  return { hosts, findings: collector.findings, unknown: collector.unknown };
}
