/**
 * Process logger: human-readable lines in standalone mode, JSON otherwise.
 * JSON output carries `version` and `component` ('server' | 'controller') in defaultMeta
 * so hosted aggregators can tell the two processes apart; both are omitted from the
 * human-readable standalone format to keep local logs terse.
 */
import winston, { type Logger } from 'winston';
import { isCredentialField, REDACTED, redactSecretShapes } from './dataExport/secretScrub';

const STANDALONE_META_SKIP = new Set(['level', 'message', 'timestamp', 'version', 'component', 'stack', 'splat']);

export function shouldColorize(): boolean {
  const noColor = process.env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') {
    return false;
  }
  const forceColor = process.env['FORCE_COLOR'];
  if (forceColor === '0') {
    return false;
  }
  if (forceColor !== undefined && forceColor !== '') {
    return true;
  }
  return process.stderr.isTTY;
}

const REDACTION_EXEMPT_KEYS = new Set(['level', 'timestamp', 'version', 'component']);

/** Email and calendar content is dropped by exact field name. */
const CONTENT_KEYS = new Set([
  'body',
  'bodytext',
  'bodyhtml',
  'textbody',
  'htmlbody',
  'html',
  'snippet',
  'raw',
  'content',
  'description',
  'attendees',
]);

const CREDENTIAL_PARAMS =
  'token|access_token|refresh_token|id_token|api_key|apikey|key|password|passwd|client_secret|secret';

/** Credentials written into free text: header lines, query or form parameters, quoted JSON fields. */
const TEXT_REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [
    /\b((?:proxy-)?authorization|cookie|set-cookie|x-api-key|api-key)(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n"'}]+)/gi,
    `$1$2${REDACTED}`,
  ],
  [new RegExp(`([?&;]|\\b)(${CREDENTIAL_PARAMS})=[^&\\s"'#]+`, 'gi'), `$1$2=${REDACTED}`],
  // An OAuth authorization code only counts as one inside a query string, not `exit code=1`.
  [/([?&])code=[^&\s"'#]+/g, `$1code=${REDACTED}`],
  [
    // Quotes are optional: a JSON parse error may quote only part of a value, or a bare one.
    /("[a-z_]*(?:password|passwd|secret|token|api_?key|authorization|cookie|verifier)[a-z_]*"\s*:\s*)(?:"(?:[^"\\]|\\.)*"?|[^\s,}"]+)/gi,
    `$1"${REDACTED}"`,
  ],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, `Basic ${REDACTED}`],
];

function isContentField(key: string, value: unknown): boolean {
  const holdsText = typeof value === 'string' || (typeof value === 'object' && value !== null);
  return holdsText && CONTENT_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/** The one name rule for a log field, applied at every depth. */
function redactField(key: string, value: unknown, seen: WeakSet<object>): unknown {
  return isCredentialField(key, value) || isContentField(key, value) ? REDACTED : redactValue(value, seen);
}

function redactText(text: string): string {
  let out = redactSecretShapes(text);
  for (const [pattern, replacement] of TEXT_REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map(entry => redactValue(entry, seen));
  }
  if (value instanceof Error) {
    // A nested Error would serialize to `{}`; keep what explains the failure, redacted.
    return {
      name: value.name,
      message: redactText(value.message),
      ...(value.stack === undefined ? {} : { stack: redactText(value.stack) }),
      ...(value.cause === undefined ? {} : { cause: redactValue(value.cause, seen) }),
    };
  }
  const entries = value instanceof Headers ? [...value.entries()] : Object.entries(value);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    out[key] = redactField(key, entry, seen);
  }
  return out;
}

/**
 * Credentials and email or calendar content never reach a log line: every entry passes here.
 * Runs after `errors()`, so an Error's message and stack are plain fields by then.
 */
const redactFormat = winston.format(info => {
  for (const key of Object.keys(info)) {
    if (!REDACTION_EXEMPT_KEYS.has(key)) {
      info[key] = redactField(key, info[key], new WeakSet());
    }
  }
  return info;
});

function standaloneMeta(info: object): string {
  const copied: Record<string, unknown> = { ...info };
  const meta: Record<string, unknown> = {};
  for (const key of Object.keys(copied)) {
    if (STANDALONE_META_SKIP.has(key)) {
      continue;
    }
    meta[key] = copied[key];
  }
  if (Object.keys(meta).length === 0) {
    return '';
  }
  return ` ${JSON.stringify(meta)}`;
}

function standaloneFormat(color: boolean): winston.Logform.Format {
  const parts: winston.Logform.Format[] = [
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    redactFormat(),
  ];
  if (color) {
    parts.push(winston.format.colorize({ level: true }));
  }
  parts.push(
    winston.format.printf(info => {
      const extra = standaloneMeta(info);
      const stack = typeof info['stack'] === 'string' ? `\n${info['stack']}` : '';
      return `${String(info['timestamp'])} ${info.level} ${String(info.message)}${extra}${stack}`;
    }),
  );
  return winston.format.combine(...parts);
}

function jsonFormat(): winston.Logform.Format {
  return winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    redactFormat(),
    winston.format.json(),
  );
}

function serverLogFormat(options: { standalone: boolean }): winston.Logform.Format {
  if (options.standalone) {
    return standaloneFormat(shouldColorize());
  }
  return jsonFormat();
}

function createLogger(options: {
  level: string;
  standalone: boolean;
  version: string;
  component: 'server' | 'controller';
}): Logger {
  return winston.createLogger({
    level: options.level,
    defaultMeta: { version: options.version, component: options.component },
    format: serverLogFormat({ standalone: options.standalone }),
    transports: [new winston.transports.Console()],
  });
}

export function createServerLogger(options: { level: string; standalone: boolean; version: string }): Logger {
  return createLogger({ ...options, component: 'server' });
}

export function createControllerLogger(options: { level: string; standalone: boolean; version: string }): Logger {
  return createLogger({ ...options, component: 'controller' });
}
