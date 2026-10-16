/**
 * Server configuration.
 *
 * Environment variables are read once at module load into a typed
 * `configuration` object exported as default. Any invalid value throws at
 * import time, so a misconfigured server fails fast at boot instead of
 * mid-run.
 *
 * `STANDALONE` is a discriminated mode selector:
 * - `true` (default): SQLite only; no Redis / executor peering.
 * - `false`: Postgres + Redis (defaults to local trueforge credentials /
 *   `redis://localhost:6379`).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import envPaths from 'env-paths';

import {
  GIT_NETWORK_ENV_NAMES,
  pickGitNetworkEnv,
  TOKEN_FACTORY_DEFAULT_BASE_URL,
  validateRunCodeStartupConfig,
} from '@truefoundry/trueforge-core/core';
import {
  MEMORY_PROVIDER_MAX_TIMEOUT_MS,
  MEMORY_SETTINGS_LIMITS,
} from '@truefoundry/trueforge-core/core/memory/memorySettingsLimits';

import { normalizedOrigin } from './mcp/firstParty';
import { PACKAGE_VERSION } from './packageVersion';
import { defaultEmbeddingModelDir } from './runtime/memory/embeddingRetrieval';
import type { ReflectBudget } from './runtime/memory/hindsightClient';
import { DEFAULT_TOKEN_FACTORY_CHEAPER_MODEL, DEFAULT_TOKEN_FACTORY_MODEL } from './runtime/tokenFactoryDefaults';
import { MAX_CODE_MODE_SOCKET_PARENT_BYTES } from './sandbox/local/core/CodeModeUdsTransport';

const DEFAULT_PORT = 8790;
/** Loopback default; container images set HOST=0.0.0.0 so probes and Service traffic reach the process. */
const DEFAULT_HOST = 'localhost';
/**
 * Default HTTP request body ceiling: 36 MiB. A 25 MiB attachment expands to roughly 33.4 MiB
 * when base64 encoded; the remainder covers the JSON turn envelope without accepting the former
 * 100 MiB decoded aggregate in one buffered request.
 */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 36 * 1024 * 1024;
/**
 * Package root whether this module runs as `src/config.ts` (tsx) or is bundled
 * into `dist/main.js` / `dist/cli.js` (`import.meta` → `dist/` → parent).
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Turn ids minted by a standalone process; no peer can ever own them. */
const LOCAL_EXECUTOR_ID = 'local';
/** OS-standard data dir for SQLite in standalone mode. */
const ENV_PATHS_APP_NAME = 'trueforge';
const DEFAULT_POSTGRES_USER = 'trueforge';
const DEFAULT_POSTGRES_PASSWORD = process.env['POSTGRES_PASSWORD'] ?? 'changeme';
const DEFAULT_POSTGRES_DB = 'trueforge';
const DEFAULT_POSTGRES_HOST = 'localhost';
const DEFAULT_POSTGRES_PORT = 5432;
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
/** Generate a fresh random standalone scheduler key (32 random bytes, hex). */
export function generateStandaloneSchedulerKey(): string {
  return randomBytes(32).toString('hex');
}

/** Hosted-mode fallback, also the Helm chart default; refused in standalone. */
const HOSTED_DEFAULT_API_KEY = 'placeholder-value-please-generate-your-own';
const PLACEHOLDER_API_KEYS: ReadonlySet<string> = new Set(['dev-only-placeholder', HOSTED_DEFAULT_API_KEY]);

export function isPlaceholderTrueForgeApiKey(key: string): boolean {
  return PLACEHOLDER_API_KEYS.has(key);
}

/**
 * Resolve the scheduler service credential. A non-empty `TRUEFORGE_API_KEY` always wins.
 * Standalone: placeholders are refused; unset generates a fresh random 32-byte key at process
 * start so instances never share a guessable key.
 * Distributed: unset falls back to the well-known placeholder (the Helm chart's default), so
 * the Compose stack starts without setup. Callers warn when the result is a placeholder.
 */
export function resolveTrueForgeApiKey({ standalone }: { standalone: boolean }): string {
  const fromEnv = getEnv('TRUEFORGE_API_KEY');
  if (fromEnv !== undefined && fromEnv !== '') {
    if (standalone && isPlaceholderTrueForgeApiKey(fromEnv)) {
      throw new Error(
        'Environment variable TRUEFORGE_API_KEY is set to a placeholder value. ' +
          'Generate a real key, or unset it so standalone generates a random key at startup.',
      );
    }
    return fromEnv;
  }
  return standalone ? generateStandaloneSchedulerKey() : HOSTED_DEFAULT_API_KEY;
}

/**
 * `BUILD_REF` when nothing stamped the build: host development, and image builds
 * run without the build arg. Reads as an admission rather than as a build id.
 */
export const UNSTAMPED_BUILD_REF = 'unknown';

const DEFAULT_OIDC_USER_REFERENCE_CLAIM = 'sub';
const DEFAULT_OIDC_USER_DISPLAY_NAME_CLAIM = 'name';
const DEFAULT_OIDC_USER_ROLE_CLAIM = 'groups';
const DEFAULT_OIDC_ADMIN_ROLE_VALUE = 'admin';
const DEFAULT_OIDC_SCOPES = 'openid,profile,email';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

export interface GetEnvOptions {
  defaultValue?: string;
  required?: boolean;
}

function getEnv(key: string, options?: GetEnvOptions): string | undefined {
  const value = process.env[key];
  if (value !== undefined) {
    return value;
  }

  // Checking for undefined as value can also be 0 or ""
  if (options?.defaultValue !== undefined) {
    return options.defaultValue;
  }

  if (options?.required) {
    throw new Error(`Environment variable ${key} is required but was not specified.`);
  }

  return undefined;
}

function randomAlphanumeric(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Environment variable PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}

export function parseOidcScopes(raw: string): string[] {
  const scopes = raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
  if (scopes.length === 0) {
    throw new Error('OIDC_SCOPES must contain at least one scope.');
  }
  return scopes;
}

/**
 * Parses `OIDC_ALLOWED_EMAILS`: comma-separated exact addresses and/or globs
 * (`*@company.com`). Empty / unset → no allowlist (any authenticated user may sign in).
 */
export function parseOidcAllowedEmails(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  return raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

/**
 * Parses `FIRST_PARTY_MCP_ORIGINS`: comma-separated exact origins (scheme, host and optional
 * port, no path) of the operator's own memory provider. Unset / blank → none, so no connector is
 * first-party. Each entry is normalized the way a connector URL's origin is, then matched exactly.
 * Anything else fails the boot: a silently dropped typo would read as "nothing is trusted", and a
 * path or wildcard would suggest a prefix or suffix match the list never does.
 */
export function parseFirstPartyMcpOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  const origins = new Set<string>();
  for (const entry of raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)) {
    const origin = normalizedOrigin(entry);
    if (origin === undefined || origin.includes('*') || new URL(entry).href !== `${origin}/`) {
      throw new Error(
        `FIRST_PARTY_MCP_ORIGINS entries must be exact http(s) origins such as https://memory.internal:8443, got: ${entry}`,
      );
    }
    origins.add(origin);
  }
  return [...origins];
}

/**
 * Source reference the running build came from. A Docker `ARG` that the build was
 * never given still reaches the process as an empty string, so blank counts as unset.
 */
export function parseBuildRef(raw: string | undefined): string {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === '' ? UNSTAMPED_BUILD_REF : trimmed;
}

/**
 * Parses the optional bug-report handoff URL. Blank means the host disabled the handoff
 * (`null`); anything set must be a valid http(s) URL, failing fast at boot otherwise.
 */
function parseHandoffUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error(`BUG_REPORT_HANDOFF_URL must be a valid http(s) URL, got: ${trimmed}`, { cause: error });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`BUG_REPORT_HANDOFF_URL must be a valid http(s) URL, got: ${trimmed}`);
  }
  return trimmed;
}

/**
 * Parses a bounded-integer env var, falling back to `defaultValue` when unset/blank. Defaults to
 * requiring a positive value (`minValue: 1`); pass `minValue: 0` for a setting whose shared
 * limit accepts zero as a valid "disable" value (e.g. {@link MEMORY_SETTINGS_LIMITS}'s
 * `recallMaxEntities`), so the env-var parser stays synchronized with that limit instead of
 * rejecting the value the schema and UI both allow. An optional `maxValue` fails fast at startup
 * instead of letting an oversized value surface later.
 */
export function parsePositiveInt(options: {
  envKey: string;
  raw: string | undefined;
  defaultValue: number;
  minValue?: number;
  maxValue?: number;
}): number {
  const { envKey, raw, defaultValue, minValue = 1, maxValue } = options;
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minValue) {
    throw new Error(`Environment variable ${envKey} must be an integer of at least ${String(minValue)}, got "${raw}"`);
  }
  if (maxValue !== undefined && value > maxValue) {
    throw new Error(`Environment variable ${envKey} must be at most ${String(maxValue)}, got "${raw}"`);
  }
  return value;
}

/** Like parsePositiveInt, but an unset or blank value stays undefined instead of taking a default. */
export function parseOptionalPositiveInt(options: { envKey: string; raw: string | undefined }): number | undefined {
  if (options.raw === undefined || options.raw.trim() === '') {
    return undefined;
  }
  return parsePositiveInt({ envKey: options.envKey, raw: options.raw, defaultValue: 1 });
}

/** Parses a float env var constrained to the closed interval [0, 1]; unset/blank falls back to `defaultValue`. */
function parseUnitInterval(options: { envKey: string; raw: string | undefined; defaultValue: number }): number {
  const { envKey, raw, defaultValue } = options;
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Environment variable ${envKey} must be a number between 0 and 1, got "${raw}"`);
  }
  return value;
}

/** Parses a boolean env var; anything but `true`/`false` throws instead of reading as `false`. */
function parseReflectBudget(options: {
  envKey: string;
  raw: string | undefined;
  defaultValue: ReflectBudget;
}): ReflectBudget {
  if (options.raw === undefined || options.raw === '') {
    return options.defaultValue;
  }
  if (options.raw === 'low' || options.raw === 'mid' || options.raw === 'high') {
    return options.raw;
  }
  throw new Error(`${options.envKey} must be one of low, mid, high; got ${JSON.stringify(options.raw)}`);
}

/** Which process-isolation backend runs `run_code` executions. */
export type SandboxIsolationDriver = 'docker' | 'firecracker';

/**
 * Parses `SANDBOX_ISOLATION_DRIVER`. Unset/blank → default. Anything else throws
 * instead of silently falling back to a different isolation backend.
 */
function parseIsolationDriver(options: {
  envKey: string;
  raw: string | undefined;
  defaultValue: SandboxIsolationDriver;
}): SandboxIsolationDriver {
  if (options.raw === undefined || options.raw.trim() === '') {
    return options.defaultValue;
  }
  const value = options.raw.trim().toLowerCase();
  if (value === 'docker' || value === 'firecracker') {
    return value;
  }
  throw new Error(`${options.envKey} must be one of docker, firecracker; got ${JSON.stringify(options.raw)}`);
}

/** Where `run_code` and the shell tools execute: Docker containers, or the gVisor sandbox slots. */
export type SandboxBackend = 'docker' | 'slots';

function parseSandboxBackend(options: { envKey: string; raw: string | undefined }): SandboxBackend {
  if (options.raw === undefined || options.raw.trim() === '') {
    return 'docker';
  }
  const value = options.raw.trim().toLowerCase();
  if (value === 'docker' || value === 'slots') {
    return value;
  }
  throw new Error(`${options.envKey} must be one of docker, slots; got ${JSON.stringify(options.raw)}`);
}

/** Most slot services the compose files define. */
export const SANDBOX_MAX_SLOTS = 4;

/** Which long-term memory backend Aman uses. */
export type MemoryBackend = 'markdown' | 'hindsight';

/**
 * Parses `MEMORY_BACKEND`. Unset/blank → default. `hindsight` is experimental
 * (rollback only); the parser accepts it but callers must treat it as unsupported.
 */
function parseMemoryBackend(options: {
  envKey: string;
  raw: string | undefined;
  defaultValue: MemoryBackend;
}): MemoryBackend {
  if (options.raw === undefined || options.raw.trim() === '') {
    return options.defaultValue;
  }
  const value = options.raw.trim().toLowerCase();
  if (value === 'markdown' || value === 'hindsight') {
    return value;
  }
  throw new Error(`${options.envKey} must be one of markdown, hindsight; got ${JSON.stringify(options.raw)}`);
}

/** How turns may route to Nebius Token Factory. */
export type TokenFactoryMode = 'off' | 'fallback' | 'force';

/**
 * Parses `TOKEN_FACTORY_MODE`. Unset/blank → `off`. `fallback` tries the configured
 * local provider first and uses Token Factory when it fails; `force` tries Token
 * Factory first (for testing and demo paths) and falls back to the local provider.
 */
export function parseTokenFactoryMode(options: {
  envKey: string;
  raw: string | undefined;
  defaultValue: TokenFactoryMode;
}): TokenFactoryMode {
  if (options.raw === undefined || options.raw.trim() === '') {
    return options.defaultValue;
  }
  const value = options.raw.trim().toLowerCase();
  if (value === 'off' || value === 'fallback' || value === 'force') {
    return value;
  }
  throw new Error(`${options.envKey} must be one of off, fallback, force; got ${JSON.stringify(options.raw)}`);
}

/** Treats an unset or blank env value as absent; used where blank is the way to switch a default off. */
function blankToUndefined(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function parseBoolean(options: { envKey: string; raw: string | undefined; defaultValue: boolean }): boolean {
  const { envKey, raw, defaultValue } = options;
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const value = raw.trim().toLowerCase();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`Environment variable ${envKey} must be "true" or "false", got "${raw}"`);
}

/**
 * Empty stays empty. Otherwise parse as a URL, store without a trailing slash
 * (callers join with `/`), and reject query/hash or `.` / `..` path segments.
 * Standalone passes `allowPath: false`: auth cookies are scoped to `/`, so a path prefix is unsupported.
 */
export function parsePublicBaseUrl(raw: string | undefined, options: { allowPath: boolean }): string {
  if (raw === undefined || raw.trim() === '') {
    return '';
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch (error) {
    throw new Error('PUBLIC_BASE_URL must be a valid URL', { cause: error });
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('PUBLIC_BASE_URL must not include a query or hash');
  }
  const segments = parsed.pathname.split('/').filter(part => part.length > 0);
  if (segments.some(part => part === '.' || part === '..')) {
    throw new Error('PUBLIC_BASE_URL path must not contain "." or ".." segments');
  }
  if (segments.length > 0 && !options.allowPath) {
    throw new Error('PUBLIC_BASE_URL must be an origin with no path when STANDALONE=true');
  }
  const path = segments.length === 0 ? '' : `/${segments.join('/')}`;
  return `${parsed.origin}${path}`;
}

/** The addresses of proxies believed about visitor addresses: plain IP addresses only, so a name cannot widen it. */
export function parseTrustedProxyAddresses(raw: string | undefined): string[] {
  const addresses: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const text = entry.trim();
    if (text === '') {
      continue;
    }
    if (isIP(text) === 0) {
      throw new Error(`TRUSTED_PROXY_ADDRESSES has an entry that is not an IP address: ${text}`);
    }
    addresses.push(text);
  }
  return addresses;
}

/** The loopback address of the sign-in service, or empty. */
export function parseLoginUpstreamUrl(raw: string | undefined): string {
  const text = (raw ?? '').trim();
  if (text === '') {
    return '';
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch (error) {
    throw new Error('LOGIN_UPSTREAM_URL must be a valid URL', { cause: error });
  }
  if (parsed.protocol !== 'http:' || !isLoopbackHost(parsed.hostname) || parsed.pathname.replace(/\/$/, '') === '') {
    throw new Error(
      'LOGIN_UPSTREAM_URL must be an http address on this computer with a path, like http://127.0.0.1:5556/dex',
    );
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
}

/** True for a host written like an address but not as four plain decimal parts, which URL parsing would quietly rewrite. */
function writesAddressInAnotherBase(text: string): boolean {
  const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]*)/i.exec(text)?.[1] ?? '';
  const parts = host.split('.');
  if (!parts.every(part => /^(0x[0-9a-f]*|[0-9]+)$/i.test(part))) {
    return false;
  }
  return !(parts.length === 4 && parts.every(part => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255));
}

/**
 * The addresses the app may be opened at, as origins. Sign-in returns to the one the request came to, so the list is
 * what keeps a request from steering it elsewhere. Plain http is only for this computer and private networks.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const origins: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const text = entry.trim();
    if (text === '') {
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch (error) {
      throw new Error(`ALLOWED_ORIGINS has an entry that is not a valid origin: ${text}`, { cause: error });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`ALLOWED_ORIGINS entries must be http or https origins: ${text}`);
    }
    if (
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(text)
    ) {
      throw new Error(`ALLOWED_ORIGINS entries must be bare origins with no path, query or login: ${text}`);
    }
    if (writesAddressInAnotherBase(text)) {
      throw new Error(
        `ALLOWED_ORIGINS has an address written in octal, hex or as one number: ${text}. Write it as four decimal parts.`,
      );
    }
    if (parsed.protocol === 'http:' && !isPrivateNetworkHost(parsed.hostname)) {
      throw new Error(
        `ALLOWED_ORIGINS has a public address over plain http (${text}). Sign-in over the internet needs https: set up HTTPS with Caddy (--tls caddy).`,
      );
    }
    if (!origins.includes(parsed.origin)) {
      origins.push(parsed.origin);
    }
  }
  return origins;
}

/**
 * Parse a maps upstream URL: must be http(s), no query or hash. Fails fast at
 * boot like PUBLIC_BASE_URL. Trailing slashes are trimmed; callers join paths.
 */
function parseMapsUrl({
  envKey,
  raw,
  defaultValue,
  requiredPlaceholders = [],
}: {
  envKey: string;
  raw: string | undefined;
  defaultValue: string;
  requiredPlaceholders?: readonly string[];
}): string {
  const value = raw === undefined || raw.trim() === '' ? defaultValue : raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`${envKey} must be a valid URL`, { cause: error });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${envKey} must be an http(s) URL`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`${envKey} must not include a query or hash`);
  }
  for (const placeholder of requiredPlaceholders) {
    if (!value.includes(placeholder)) {
      throw new Error(`${envKey} must include the ${placeholder} placeholder`);
    }
  }
  return value.endsWith('/') && value.length > 1 ? value.slice(0, -1) : value;
}

/** Parses `MAPS_ROUTER_PROVIDER`. Unset/blank → `osrm`. Unknown values throw. */
function parseMapsRouterProvider(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    return 'osrm';
  }
  const value = raw.trim().toLowerCase();
  if (value === 'osrm') {
    return value;
  }
  throw new Error(`Environment variable MAPS_ROUTER_PROVIDER must be "osrm", got ${JSON.stringify(raw)}`);
}

function parseTrueFoundrySandboxProvider(raw: string | undefined): 'daytona' | 'truefoundry' | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim();
  if (value === 'daytona' || value === 'truefoundry') {
    return value;
  }
  throw new Error(
    `Environment variable TRUEFOUNDRY_SANDBOX_PROVIDER must be "daytona" or "truefoundry", got ${JSON.stringify(raw)}`,
  );
}

/** Parses `POSTGRES_SSL_MODE`. Unset/blank → `''`. Unknown values throw. */
function parsePostgresSslMode(raw: string | undefined): string {
  if (!raw) {
    return '';
  }
  const mode = raw.trim();
  if (mode === '') {
    return '';
  }
  switch (mode) {
    case 'disable':
    case 'prefer':
    case 'require':
    case 'verify-ca':
    case 'verify-full':
    case 'no-verify':
      return mode;
    default:
      throw new Error(
        'Environment variable POSTGRES_SSL_MODE must be one of disable, prefer, require, verify-ca, ' +
          `verify-full, no-verify; got "${mode}"`,
      );
  }
}

/**
 * Prefer `dist/_frontend` shipped in the npm tarball (npx / `pnpm start`).
 * Fall back to the monorepo sibling `../frontend/dist` (host-dev before a copy).
 */
function resolveDefaultFrontendDir(): string {
  const packaged = path.join(PACKAGE_ROOT, 'dist', '_frontend');
  if (existsSync(path.join(packaged, 'index.html'))) {
    return packaged;
  }
  return path.join(PACKAGE_ROOT, '..', 'frontend', 'dist');
}

function resolveFrontendDir(): string {
  const override = getEnv('FRONTEND_DIR');
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override);
  }
  return resolveDefaultFrontendDir();
}

/** Absolute path from an optional env override; unset/blank → `undefined`. */
function resolveOptionalPathEnv(envKey: string): string | undefined {
  const override = getEnv(envKey);
  if (override === undefined || override.trim() === '') {
    return undefined;
  }
  return path.resolve(override);
}

/**
 * Absolute SQLite file path for standalone mode.
 * Env: `SQLITE_PATH` (optional). Default: `{app data dir}/db/db.sqlite`.
 */
function resolveSqlitePath(appDataDir: string): string {
  const override = getEnv('SQLITE_PATH');
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override);
  }
  return path.join(appDataDir, 'db', 'db.sqlite');
}

/** Parent for local sandbox roots. Same app data dir as SQLite. */
function resolveLocalSandboxRootParent(appDataDir: string): string {
  return path.join(appDataDir, 'sandboxes');
}

/**
 * Per-port tmp parent for Code Mode UDS socks, so multiple standalone instances
 * on one machine neither share nor wipe each other's sockets.
 * Fails clearly when the realpath would exceed the 65-byte socket budget.
 */
export function resolveCodeModeSocketParent({
  port,
  realpathFn = realpathSync,
}: {
  port: number;
  realpathFn?: (path: string) => string;
}): string {
  const parent = path.join(os.tmpdir(), `tf_cms_${String(port)}`);
  const realParent = path.join(realpathFn(os.tmpdir()), `tf_cms_${String(port)}`);
  const bytes = Buffer.byteLength(realParent, 'utf8');
  if (bytes > MAX_CODE_MODE_SOCKET_PARENT_BYTES) {
    throw new Error(
      `Code Mode socket parent path too long after realpath (${String(bytes)} bytes, max ${String(MAX_CODE_MODE_SOCKET_PARENT_BYTES)}): ${realParent}. ` +
        'Set TMPDIR to a shorter path.',
    );
  }
  return parent;
}

/** Redis peering URL for distributed mode. Env: `REDIS_URL`. */
function resolveRedisUrl(): string {
  const raw = getEnv('REDIS_URL', { defaultValue: DEFAULT_REDIS_URL }) ?? DEFAULT_REDIS_URL;
  if (raw.trim() === '') {
    throw new Error('Environment variable REDIS_URL must be non-empty when STANDALONE=false.');
  }
  return raw;
}

/**
 * Postgres connection string for distributed mode.
 * Prefers `DATABASE_URL` when set (Railway / managed Postgres); otherwise builds from `POSTGRES_*`.
 */
function resolvePostgresDatabaseUrl(): string {
  const databaseUrl = getEnv('DATABASE_URL');
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') {
    return databaseUrl.trim();
  }

  const postgresUser = getEnv('POSTGRES_USER', { defaultValue: DEFAULT_POSTGRES_USER }) ?? DEFAULT_POSTGRES_USER;
  const postgresPassword =
    getEnv('POSTGRES_PASSWORD', { defaultValue: DEFAULT_POSTGRES_PASSWORD }) ?? DEFAULT_POSTGRES_PASSWORD;
  const postgresDb = getEnv('POSTGRES_DB', { defaultValue: DEFAULT_POSTGRES_DB }) ?? DEFAULT_POSTGRES_DB;
  const postgresHost = getEnv('POSTGRES_HOST', { defaultValue: DEFAULT_POSTGRES_HOST }) ?? DEFAULT_POSTGRES_HOST;
  const postgresPort = parsePositiveInt({
    envKey: 'POSTGRES_PORT',
    raw: getEnv('POSTGRES_PORT'),
    defaultValue: DEFAULT_POSTGRES_PORT,
  });
  const postgresSslMode = parsePostgresSslMode(getEnv('POSTGRES_SSL_MODE'));
  if (
    postgresUser.trim() === '' ||
    postgresPassword.trim() === '' ||
    postgresDb.trim() === '' ||
    postgresHost.trim() === ''
  ) {
    throw new Error(
      'Set DATABASE_URL, or set non-empty POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, and POSTGRES_HOST when STANDALONE=false.',
    );
  }

  return buildPostgresConnectionString({
    user: postgresUser,
    password: postgresPassword,
    host: postgresHost,
    port: postgresPort,
    database: postgresDb,
    sslMode: postgresSslMode,
  });
}

/** Builds a Postgres connection URL from discrete `POSTGRES_*` parts. */
function buildPostgresConnectionString(parts: {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
  sslMode: string;
}): string {
  let connectionString = `postgres://${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.password)}@${parts.host}:${String(parts.port)}/${encodeURIComponent(parts.database)}`;
  if (parts.sslMode !== '') {
    connectionString += `?sslmode=${encodeURIComponent(parts.sslMode)}`;
  }
  return connectionString;
}

/** An http issuer is accepted only on a loopback host; anything else must be https. */
export function assertOidcIssuerTransportAllowed(issuerUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(issuerUrl);
  } catch (error) {
    throw new Error('OIDC_ISSUER_URL must be a valid URL', { cause: error });
  }
  if (parsed.protocol === 'https:') {
    return;
  }
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) {
    return;
  }
  throw new Error('OIDC_ISSUER_URL must use https, except http on a loopback host (localhost, 127.0.0.1, ::1)');
}

/** Cookie-name-safe suffix appended to every auth cookie name so instances on one hostname stay apart. */
function parseAuthCookieSuffix(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (!/^[A-Za-z0-9_-]{0,32}$/.test(value)) {
    throw new Error('AUTH_COOKIE_SUFFIX must be at most 32 letters, digits, "_" or "-"');
  }
  return value;
}

function resolveOIDCConfig(): OIDCConfig | undefined {
  const issuerUrl = getEnv('OIDC_ISSUER_URL');
  const clientId = getEnv('OIDC_CLIENT_ID');
  const clientSecret = getEnv('OIDC_CLIENT_SECRET');

  if (!issuerUrl && !clientId && !clientSecret) {
    return undefined;
  }
  if (!issuerUrl || !clientId || !clientSecret) {
    const missing = [
      ['OIDC_ISSUER_URL', issuerUrl],
      ['OIDC_CLIENT_ID', clientId],
      ['OIDC_CLIENT_SECRET', clientSecret],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    throw new Error(
      `OIDC_ISSUER_URL, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET must all be set together, or all left unset. Missing: ${missing.join(', ')}.`,
    );
  }
  assertOidcIssuerTransportAllowed(issuerUrl);
  return {
    OIDC_ISSUER_URL: issuerUrl,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: clientSecret,
    OIDC_USER_REFERENCE_CLAIM:
      getEnv('OIDC_USER_REFERENCE_CLAIM', { defaultValue: DEFAULT_OIDC_USER_REFERENCE_CLAIM }) ??
      DEFAULT_OIDC_USER_REFERENCE_CLAIM,
    OIDC_USER_DISPLAY_NAME_CLAIM:
      getEnv('OIDC_USER_DISPLAY_NAME_CLAIM', { defaultValue: DEFAULT_OIDC_USER_DISPLAY_NAME_CLAIM }) ??
      DEFAULT_OIDC_USER_DISPLAY_NAME_CLAIM,
    OIDC_USER_ROLE_CLAIM:
      getEnv('OIDC_USER_ROLE_CLAIM', { defaultValue: DEFAULT_OIDC_USER_ROLE_CLAIM }) ?? DEFAULT_OIDC_USER_ROLE_CLAIM,
    OIDC_ADMIN_ROLE_VALUE:
      getEnv('OIDC_ADMIN_ROLE_VALUE', { defaultValue: DEFAULT_OIDC_ADMIN_ROLE_VALUE }) ?? DEFAULT_OIDC_ADMIN_ROLE_VALUE,
    OIDC_SCOPES: parseOidcScopes(getEnv('OIDC_SCOPES', { defaultValue: DEFAULT_OIDC_SCOPES }) ?? DEFAULT_OIDC_SCOPES),
    OIDC_ALLOWED_EMAILS: parseOidcAllowedEmails(getEnv('OIDC_ALLOWED_EMAILS')),
  };
}

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

export interface OIDCConfig {
  /** e.g. an Okta custom authorization server, or an Azure AD tenant's v2.0 endpoint. Env: `OIDC_ISSUER_URL`. */
  OIDC_ISSUER_URL: string;
  /** Client ID for the OIDC client;*/
  OIDC_CLIENT_ID: string;
  /** Client secret for the OIDC client*/
  OIDC_CLIENT_SECRET: string;
  /** Claim to be used as the user reference; e.g. "sub" or "email"
   * Optional; defaults to "sub"
   */
  OIDC_USER_REFERENCE_CLAIM: string;
  /** Claim used as the display name; e.g. "name" or "preferred_username".
   * Optional; defaults to "name". Missing/empty falls back to the user reference.
   * Env: `OIDC_USER_DISPLAY_NAME_CLAIM`.
   */
  OIDC_USER_DISPLAY_NAME_CLAIM: string;
  /** Claim to be used as the user role; e.g. "role" or "groups"
   * Optional; defaults to "groups"
   */
  OIDC_USER_ROLE_CLAIM: string;
  /** Value of the user role claim that will be used to grant admin access to the server
   * Case sensitive. Optional; defaults to "admin"
   */
  OIDC_ADMIN_ROLE_VALUE: string;
  /** Comma-separated OAuth scopes for the authorization request. Env: `OIDC_SCOPES`.
   * Optional; defaults to "openid,profile,email". Whitespace around entries is stripped.
   * Okta `groups` claims require the `groups` scope; Azure AD app roles typically omit it.
   */
  OIDC_SCOPES: string[];
  /**
   * Optional allowlist of emails that may sign in. Env: `OIDC_ALLOWED_EMAILS`.
   * Comma-separated exact addresses and/or `*` globs (e.g. `alice@acme.com,*@partner.com`).
   * Matching is case-insensitive against the ID token `email` claim. Empty = unrestricted.
   */
  OIDC_ALLOWED_EMAILS: string[];
}

export interface SharedServerConfiguration {
  /** Log level. Env: `LOG_LEVEL`. */
  LOG_LEVEL: string;
  /** Log one line per HTTP request (except `/healthz`). Env: `ACCESS_LOGS`. Default true. */
  ACCESS_LOGS: boolean;
  /** Node environment. Env: `NODE_ENV`. */
  NODE_ENV: string | undefined;
  /**
   * Source reference the running build was stamped with at image build time, so a
   * deployment can say which build it is. Env: `BUILD_REF`. Default `unknown`.
   */
  BUILD_REF: string;
  /**
   * Optional issue-tracker URL bug reports hand off to. The UI's "File on GitHub" button opens
   * this URL with the generated report pre-filled; when unset, the handoff button is hidden.
   * Env: `BUG_REPORT_HANDOFF_URL`. Default `null`.
   */
  BUG_REPORT_HANDOFF_URL: string | null;
  /** HTTP port the server listens on. Env: `PORT`. */
  PORT: number;
  /** HTTP bind address. Env: `HOST`. Default `localhost`; production images use `0.0.0.0`. */
  HOST: string;
  /**
   * Distributed mode only: refuse startup when the server would listen on a non-loopback address
   * without authentication. Env: `REQUIRE_AUTH`. Default `true`; set `false` to explicitly accept
   * the risk, e.g. for the local-dev compose stack behind a loopback-published port.
   * Standalone always requires OIDC and ignores this.
   */
  REQUIRE_AUTH: boolean;
  /**
   * OIDC configuration for server authentication, in both modes. Undefined means browser login
   * is disabled, which standalone refuses at startup.
   */
  OIDC: OIDCConfig | undefined;
  /**
   * Suffix appended to every auth cookie name so instances sharing a hostname (cookies ignore
   * ports) do not read each other's sessions. Env: `AUTH_COOKIE_SUFFIX`. Default empty.
   */
  AUTH_COOKIE_SUFFIX: string;
  /** Peering identity embedded in the turn ids this process mints; `local` in standalone mode. */
  EXECUTOR_ID: string;
  /**
   * Optional override for the model catalog YAML (discovery presets for
   * GET /catalogs/model-providers). When unset, the catalog inlined at build
   * time is used. Env: `MODEL_CATALOG_PATH`.
   */
  MODEL_CATALOG_PATH: string | undefined;
  /**
   * Optional override for the MCP catalog YAML (discovery presets for
   * GET /catalogs/mcp-servers). When unset, the catalog inlined at build
   * time is used. Env: `MCP_CATALOG_PATH`.
   */
  MCP_CATALOG_PATH: string | undefined;
  /**
   * Optional override for the skill catalog YAML (discovery presets for
   * GET /catalogs/skills). When unset, the catalog inlined at build
   * time is used. Env: `SKILL_CATALOG_PATH`.
   */
  SKILL_CATALOG_PATH: string | undefined;
  /**
   * Optional override for the sandbox catalog YAML (discovery presets for
   * GET /catalogs/sandbox-providers). When unset, the catalog inlined at build
   * time is used. Env: `SANDBOX_CATALOG_PATH`.
   */
  SANDBOX_CATALOG_PATH: string | undefined;
  /**
   * Frontend build served alongside the API; a missing directory leaves the server API-only.
   * Env: `FRONTEND_DIR`. Default: packaged `dist/_frontend` (npx tarball) or
   * monorepo `packages/frontend/dist` — always absolute, independent of CWD.
   */
  FRONTEND_DIR: string;
  /** Max milliseconds for one MCP request. Env: `MCP_REQUEST_TIMEOUT_MS`. Default 4 minutes. */
  MCP_REQUEST_TIMEOUT_MS: number;
  /** Max milliseconds for an MCP transport connection. Env: `MCP_CONNECT_TIMEOUT_MS`. Default 30 seconds. */
  MCP_CONNECT_TIMEOUT_MS: number;
  /**
   * Origins of the operator's own memory provider, as normalized `scheme://host[:port]` strings.
   * A connector saved as the memory provider on one of these origins is first-party: its tools that
   * declare `readOnlyHint` true and `openWorldHint` false run without an approval card. Empty means
   * no connector is first-party. Env: `FIRST_PARTY_MCP_ORIGINS` (comma-separated). Default empty.
   */
  FIRST_PARTY_MCP_ORIGINS: string[];
  /**
   * Max concurrent read-only (Phase-A) tool-call dispatches per assistant batch.
   * Env: `TOOL_DISPATCH_MAX_CONCURRENCY`. Default 4.
   */
  TOOL_DISPATCH_MAX_CONCURRENCY: number;
  /**
   * Per-tool-call dispatch deadline in milliseconds: how long a turn waits for
   * one provider call before recording `outcome_unknown`. It does not cancel
   * the underlying provider call. Env: `TOOL_CALL_TIMEOUT_MS`. Default 240000
   * (4 minutes). run_code is scoped out of this — it gets its own provisioning-sized
   * deadline (see `getRunCodeToolCallTimeoutMs`), so the 21-minute bound
   * applies to sandbox/run_code alone, not every tool.
   * Must stay below `SERVER_EXECUTION_TIMEOUT_SECONDS`.
   */
  TOOL_CALL_TIMEOUT_MS: number;
  /**
   * Bound in milliseconds on waiting for a model call's first output before
   * the turn fails visibly instead of hanging. A provider that accepts the
   * request but never produces a first chunk would otherwise leave the turn
   * active indefinitely. Env: `MODEL_FIRST_RESPONSE_TIMEOUT_MS`. Default
   * 600000 (10 minutes).
   */
  MODEL_FIRST_RESPONSE_TIMEOUT_MS: number;
  /**
   * Client name used for Dynamic Client Registration (DCR) of MCP servers.
   * This is the client name shown on authorization-server consent screens.
   * Env: `MCP_DCR_OAUTH_CLIENT_NAME`. Default: "truefoundry-harness".
   */
  MCP_DCR_OAUTH_CLIENT_NAME: string;
  /**
   * Max bytes for a single file download out of the sandbox.
   * Env: `SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD`. Default 25 MiB (document limit).
   */
  SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD: number;
  /**
   * run_code isolation driver. Env: `SANDBOX_ISOLATION_DRIVER`. Default 'docker';
   * 'firecracker' is opt-in but config-only in this build (the driver is not
   * implemented yet, so selecting it refuses to start). Selection happens once at
   * server start; changing it requires a config change and restart.
   */
  SANDBOX_ISOLATION_DRIVER: SandboxIsolationDriver;
  /**
   * Where sandboxed code runs. Env: `SANDBOX_BACKEND`. Default 'docker'; 'slots' sends run_code and the
   * shell and file tools to the gVisor sandbox slots, and then ignores SANDBOX_IMAGE and the cosign key.
   */
  SANDBOX_BACKEND: SandboxBackend;
  /** Number of slot agents to use, 1 to 4. Env: `SANDBOX_SLOTS`. Default 4. */
  SANDBOX_SLOTS: number;
  /**
   * Directory holding one control directory per slot (`<dir>/<n>/agent.sock`). Env: `SANDBOX_SLOTS_DIR`.
   * Required when SANDBOX_BACKEND=slots.
   */
  SANDBOX_SLOTS_DIR: string;
  /** Disk quota of one chat's sandbox workspace on a slot, MiB. Env: `SANDBOX_SESSION_DISK_MB`. Default 2048. */
  SANDBOX_SESSION_DISK_MB: number;
  /**
   * Expected sandbox image as `<tag>@sha256:<64 hex chars>`. Never a bare
   * tag: the digest pin is enforced before any pull. Env: `SANDBOX_IMAGE`.
   * Blank (the default) leaves run_code dormant — existing standalone installs
   * boot without it; the release process stamps the built digest here to opt
   * in, and a non-blank value gets the full fail-closed startup validation.
   */
  SANDBOX_IMAGE: string;
  /**
   * Parent directory for per-run run_code isolation dirs
   * (`<dir>/sandbox-runs/<runId>/{ingress,scratch,egress}`).
   * Derived: `{app data dir}/sandbox-runs` (both topologies: the Docker
   * driver is host-local even in distributed mode).
   */
  SANDBOX_RUNS_DIR: string;
  /**
   * Directory where the Docker driver remembers its last successful image
   * signature verification, so readiness works offline.
   * Derived: `{app data dir}/sandbox-state`.
   */
  SANDBOX_STATE_DIR: string;
  /**
   * Scratch directory for the server's own git work on behalf of sandbox slots (clone, fetch, push). Every
   * operation uses a fresh subdirectory and removes it. Derived: `{app data dir}/git-bridge`.
   */
  SANDBOX_GIT_BRIDGE_DIR: string;
  /**
   * Proxy and certificate settings the server's own git (for sandbox slots) may use, copied from the process
   * environment: HTTPS_PROXY, NO_PROXY, SSL_CERT_FILE, SSL_CERT_DIR, GIT_SSL_CAINFO, GIT_SSL_CAPATH and
   * CURL_CA_BUNDLE. Nothing else of the environment reaches git.
   */
  SANDBOX_GIT_NETWORK_ENV: Readonly<Record<string, string>>;
  /**
   * Default per-run timeout for run_code, seconds. Env: `SANDBOX_DEFAULT_TIMEOUT_SECONDS`. Default 60.
   */
  SANDBOX_DEFAULT_TIMEOUT_SECONDS: number;
  /**
   * Max per-run timeout for run_code, seconds. Env: `SANDBOX_MAX_TIMEOUT_SECONDS`. Default 600.
   */
  SANDBOX_MAX_TIMEOUT_SECONDS: number;
  /**
   * Container memory limit for run_code, MiB. Env: `SANDBOX_MEMORY_MB`. Default 2048.
   */
  SANDBOX_MEMORY_MB: number;
  /**
   * Scratch+egress disk quota for run_code, MiB. Env: `SANDBOX_DISK_MB`. Default 1024.
   */
  SANDBOX_DISK_MB: number;
  /**
   * Per-stream stdout/stderr cap for run_code, KiB. Env: `SANDBOX_STDOUT_STDERR_CAP_KB`. Default 256.
   */
  SANDBOX_STDOUT_STDERR_CAP_KB: number;
  /**
   * Bound for the first-run image pull, seconds. Startup asserts
   * run_code's own dispatch deadline (`getRunCodeToolCallTimeoutMs`) covers
   * this plus max_timeout_seconds, fail-closed — the normal per-tool timeout
   * is scoped out. Env: `SANDBOX_IMAGE_PULL_TIMEOUT_SECONDS`. Default 600.
   */
  SANDBOX_IMAGE_PULL_TIMEOUT_SECONDS: number;
  /**
   * RESERVED for a future version. v1 drivers ignore it; startup FAILS CLOSED
   * when true. Env: `SANDBOX_NETWORK_EGRESS`. Default false.
   */
  SANDBOX_NETWORK_EGRESS: boolean;
  /**
   * Path to the cosign public-key PEM used to verify the sandbox image signature
   * (fail-closed). Env: `SANDBOX_COSIGN_PUBLIC_KEY_PATH`. Required when
   * the isolation driver is docker; the release process ships the key.
   */
  SANDBOX_COSIGN_PUBLIC_KEY_PATH: string;
  /**
   * Turn artifact retention: index rows (and blobs no surviving row references)
   * older than this many days are deleted by a daily startup-anchored sweep.
   * Env: `TURN_ARTIFACT_RETENTION_DAYS`. Default 30.
   */
  TURN_ARTIFACT_RETENTION_DAYS: number;
  /**
   * Firecracker stanza — config only in this build; the driver is parked until
   * /dev/kvm is confirmed on the target host. Only read when
   * SANDBOX_ISOLATION_DRIVER=firecracker.
   */
  SANDBOX_FIRECRACKER_KVM_DEVICE: string;
  SANDBOX_FIRECRACKER_KERNEL: string;
  SANDBOX_FIRECRACKER_ROOTFS: string;
  SANDBOX_FIRECRACKER_SNAPSHOT_ENABLED: boolean;
  /**
   * Max bytes for an HTTP request body. Env: `MAX_REQUEST_BODY_BYTES`. Default 36 MiB.
   */
  MAX_REQUEST_BODY_BYTES: number;
  /**
   * Max total bytes of a data export archive. The export aborts (and the download fails) rather
   * than shipping a truncated archive when the cap is exceeded. Env: `DATA_EXPORT_MAX_BYTES`.
   * Default 1 GiB.
   */
  DATA_EXPORT_MAX_BYTES: number;
  /**
   * Instance-wide context size in tokens that triggers compaction, used whenever an agent spec
   * does not set `config.context_management.compaction.trigger` itself; an explicit spec value
   * always wins. Unset leaves the threshold to the model's context length (80% of it, lowered so
   * input plus the configured max output tokens fit, never below 4000), with a fixed 50000-token
   * fallback when that length is unknown.
   * Env: `CONTEXT_COMPACTION_THRESHOLD_TOKENS`.
   */
  CONTEXT_COMPACTION_THRESHOLD_TOKENS: number | undefined;
  /**
   * Max seconds to wait for turn cancellation + connection drain on SIGTERM/SIGINT.
   * Env: `GRACEFUL_TIMEOUT_SECONDS`. Default 30.
   */
  GRACEFUL_TIMEOUT_SECONDS: number;
  /**
   * Max milliseconds shutdown waits for in-flight turn event drains (memory retain,
   * profile learning, artifact persistence) before tearing down the database.
   * Env: `TURN_DRAIN_SHUTDOWN_TIMEOUT_MS`. Default 30000.
   */
  TURN_DRAIN_SHUTDOWN_TIMEOUT_MS: number;
  /**
   * Max seconds a single turn may execute before it is cancelled with
   * `server-execution-timeout`. Env: `SERVER_EXECUTION_TIMEOUT_SECONDS`.
   * Default 1380 (23 minutes): must stay above run_code's dispatch deadline
   * (21 minutes at default sandbox bounds — 600 s image pull + 600 s run —
   * see `getRunCodeToolCallTimeoutMs`) so a worst-case run_code call is not
   * killed by the turn deadline first.
   */
  SERVER_EXECUTION_TIMEOUT_SECONDS: number;
  /**
   * TTL for a running turn's resumable event stream.
   * Env: `TURN_STREAM_TTL_SECONDS`. Default execution timeout + 300.
   */
  TURN_STREAM_TTL_SECONDS: number;
  /**
   * TTL retained after `turn.done` so subscribers can drain remaining events.
   * Env: `TURN_STREAM_POST_COMPLETION_TTL_SECONDS`. Default 300.
   */
  TURN_STREAM_POST_COMPLETION_TTL_SECONDS: number;
  /**
   * Max ms to keep a turn subscription open.
   * Env: `TURN_SUBSCRIBE_TIMEOUT_MS`. Default 600000.
   */
  TURN_SUBSCRIBE_TIMEOUT_MS: number;
  /**
   * Max ms to wait for a peer executor's reply before failing with 424.
   * Env: `REDIS_REQUEST_REPLY_TIMEOUT_MS`. Default 60000.
   * Only used when a Redis client is wired (distributed mode).
   */
  REDIS_REQUEST_REPLY_TIMEOUT_MS: number;
  /**
   * How often this process refreshes its peering heartbeat key.
   * Env: `REDIS_REQUEST_REPLY_HEARTBEAT_INTERVAL_MS`. Default 5000.
   * Only used when a Redis client is wired (distributed mode).
   */
  REDIS_REQUEST_REPLY_HEARTBEAT_INTERVAL_MS: number;
  /**
   * TTL for reply values so abandoned reply keys are reclaimed.
   * Env: `REDIS_REQUEST_REPLY_REPLY_TTL_MS`. Default 120000.
   * Only used when a Redis client is wired (distributed mode).
   */
  REDIS_REQUEST_REPLY_REPLY_TTL_MS: number;
  /**
   * Sleep between reply poll attempts while waiting on a peer.
   * Env: `REDIS_REQUEST_REPLY_POLL_INTERVAL_MS`. Default 500.
   * Only used when a Redis client is wired (distributed mode).
   */
  REDIS_REQUEST_REPLY_POLL_INTERVAL_MS: number;
  /**
   * Public application URL (origin plus optional pathname). Used as the origin of
   * MCP OAuth and OIDC callbacks; the pathname is the UI/API public prefix when
   * a reverse proxy strips it. Standalone requires an origin with no path and defaults to
   * `http://localhost:$PORT` when unset; elsewhere MCP OAuth and OIDC callback construction
   * fail if empty. Env: `PUBLIC_BASE_URL`.
   */
  PUBLIC_BASE_URL: string;
  /**
   * Addresses the app may be opened at, as comma-separated origins. Set for an instance opened on the local network:
   * sign-in then returns to the origin of the request (if listed) and the app serves the sign-in service under
   * `/dex` itself. Empty keeps the single `PUBLIC_BASE_URL` origin. Env: `ALLOWED_ORIGINS`.
   */
  ALLOWED_ORIGINS: string[];
  /**
   * Where the sign-in service listens on this computer (loopback http, with the issuer's path), for an instance whose
   * issuer is a public https address: the app then passes sign-in pages under that address through itself and limits
   * password guessing. Empty leaves the issuer's address to answer for itself. Env: `LOGIN_UPSTREAM_URL`.
   */
  LOGIN_UPSTREAM_URL: string;
  /**
   * Addresses of a reverse proxy in front of the app, besides this computer's own, whose X-Forwarded-For says which
   * visitor a request came from (so password guessing is limited per visitor, not per proxy). Comma separated IP
   * addresses. Env: `TRUSTED_PROXY_ADDRESSES`.
   */
  TRUSTED_PROXY_ADDRESSES: string[];
  /**
   * Max tokens requested from the memory provider's recall endpoint.
   * Env: `MEMORY_RECALL_MAX_TOKENS`. Default 2048.
   */
  MEMORY_RECALL_MAX_TOKENS: number;
  /**
   * Max tokens requested for the recall response's entity summaries.
   * Env: `MEMORY_RECALL_ENTITY_TOKENS`. Default 512.
   */
  MEMORY_RECALL_ENTITY_TOKENS: number;
  /**
   * Max milliseconds to wait for a memory recall before the turn proceeds without it. Capped at
   * the shared memory deadline maximum (120000); a larger value fails fast at startup.
   * Env: `MEMORY_RECALL_TIMEOUT_MS`. Default 2500.
   */
  MEMORY_RECALL_TIMEOUT_MS: number;
  /**
   * How many of the most recent non-internal user messages form the memory recall query, oldest
   * first and newest last, bounded by the query character budget. A short follow-up such as
   * "try again" then still carries the question it follows, including across a conversational
   * aside between retries. Env: `MEMORY_RECALL_QUERY_WINDOW`. Default 5.
   */
  MEMORY_RECALL_QUERY_WINDOW: number;
  /**
   * Relevance floor for a recalled item or entity summary that carries a provider score:
   * anything scored below this is dropped before it reaches the model. Ignored for a response
   * with no scores at all, where `MEMORY_RECALL_MAX_ITEMS` / `MEMORY_RECALL_MAX_ENTITIES` apply
   * instead. Env: `MEMORY_RECALL_MIN_SCORE`. Default 0.5.
   */
  MEMORY_RECALL_MIN_SCORE: number;
  /**
   * Most recalled items kept, by provider rank, when the response carries no per-item score.
   * Env: `MEMORY_RECALL_MAX_ITEMS`. Default 12.
   */
  MEMORY_RECALL_MAX_ITEMS: number;
  /**
   * Most entity summaries kept, by provider rank, when the response carries no per-entity score.
   * Env: `MEMORY_RECALL_MAX_ENTITIES`. Default 8.
   */
  MEMORY_RECALL_MAX_ENTITIES: number;
  /**
   * Max milliseconds for a memory retain (or operation-status) call.
   * Env: `MEMORY_RETAIN_TIMEOUT_MS`. Default 10000.
   */
  MEMORY_RETAIN_TIMEOUT_MS: number;
  /**
   * Max bytes read from a memory provider HTTP response body.
   * Env: `MEMORY_MAX_RESPONSE_BYTES`. Default 524288 (512 KiB).
   */
  MEMORY_MAX_RESPONSE_BYTES: number;
  /**
   * Max pending retain operations swept (status-checked) per turn.
   * Env: `MEMORY_SWEEP_MAX_PER_TURN`. Default 5.
   */
  MEMORY_SWEEP_MAX_PER_TURN: number;
  /**
   * Max milliseconds for the memory-provider connection check run on save and on demand.
   * Longer than the recall timeout: a check waits on a cold provider rather than rejecting
   * a correct configuration, while a turn degrades fast.
   * Capped at the shared memory deadline maximum (120000); a larger value fails fast at startup.
   * Env: `MEMORY_CHECK_TIMEOUT_MS`. Default 5000.
   */
  MEMORY_CHECK_TIMEOUT_MS: number;
  /**
   * Memory recall screen: master switch for the prompt-injection screen applied to recalled
   * memories at the moment they would be injected into the model's context. This is a separate
   * subsystem from the memory provider (Hindsight): the provider stores and recalls, this screen
   * decides which recalled items are allowed to reach the model this turn. Off by default, so
   * until an operator deploys the screen sidecar and turns this on, recall is lossless and
   * unscreened exactly as before. Env: `MEMORY_SCREEN_ENABLED`. Default false.
   */
  MEMORY_SCREEN_ENABLED: boolean;
  /**
   * Base URL of the `aman-content-screen` classifier the recall screen calls (`POST {url}/classify`).
   * Distinct from the memory provider URL. Only consulted when `MEMORY_SCREEN_ENABLED` is true;
   * empty or unreachable degrades to an "unknown" screen result, never a thrown turn.
   * Env: `MEMORY_SCREEN_URL`. Default empty.
   */
  MEMORY_SCREEN_URL: string;
  /**
   * Base URL of the `aman-stt` speech-to-text sidecar (`POST {url}/v1/transcribe`).
   * The browser never calls it directly; the voice endpoints proxy through this server.
   * Env: `STT_URL`. Default `http://aman-stt:8001`.
   */
  STT_URL: string;
  /**
   * Base URL of the Nominatim-compatible geocoder used by the embedded maps tools.
   * Env: `MAPS_GEOCODER_URL`. Default `https://nominatim.openstreetmap.org`.
   */
  MAPS_GEOCODER_URL: string;
  /**
   * Routing provider id for the embedded maps tools. Only `osrm` is implemented in v1;
   * the interface leaves room for a traffic-aware provider later.
   * Env: `MAPS_ROUTER_PROVIDER`. Default `osrm`.
   */
  MAPS_ROUTER_PROVIDER: string;
  /**
   * Base URL of the routing provider used by the embedded maps tools.
   * Env: `MAPS_ROUTER_URL`. Default `https://router.project-osrm.org`.
   */
  MAPS_ROUTER_URL: string;
  /**
   * Tile URL template used by the same-origin tile proxy, with `{z}`, `{x}`, `{y}` placeholders.
   * Env: `MAPS_TILE_URL`. Default `https://tile.openstreetmap.org/{z}/{x}/{y}.png`.
   */
  MAPS_TILE_URL: string;
  /**
   * User-Agent sent to the geocoder, router, and tile upstreams.
   * Env: `MAPS_USER_AGENT`. Default `Amanuensis/<version> (+https://github.com/ClimbOutLabs/amanuensis)`.
   */
  MAPS_USER_AGENT: string;
  /**
   * Bearer token for the memory recall screen classifier. Distinct from any memory-provider
   * credential. Env: `MEMORY_SCREEN_AUTH_TOKEN`. Default empty.
   */
  MEMORY_SCREEN_AUTH_TOKEN: string;
  /**
   * Score at or above which the recall screen treats a classifier verdict as malicious, forwarded
   * to the classifier as its `threshold`. Env: `MEMORY_SCREEN_THRESHOLD`. Default 0.5.
   */
  MEMORY_SCREEN_THRESHOLD: number;
  /**
   * Max milliseconds one recall-screen classify call may take. Screening runs in parallel across
   * recalled items and is further clamped to the remaining recall budget, so it never delays the
   * turn past the recall timeout. Kept well inside `MEMORY_RECALL_TIMEOUT_MS`.
   * Env: `MEMORY_SCREEN_TIMEOUT_MS`. Default 1500.
   */
  MEMORY_SCREEN_TIMEOUT_MS: number;
  /**
   * Max recall-screen classify calls in flight at once across a turn's items and entities. Bounds
   * outbound fan-out so a provider response with many entities cannot spawn one simultaneous request
   * per datum and exhaust sockets or overload the classifier sidecar.
   * Env: `MEMORY_SCREEN_MAX_CONCURRENCY`. Default 8.
   */
  MEMORY_SCREEN_MAX_CONCURRENCY: number;
  /**
   * Master switch for screening structurally open-world tool results before they re-enter model
   * context. Uses the same classifier URL, bearer token, and threshold as the memory recall screen.
   * Env: `TOOL_OUTPUT_SCREEN_ENABLED`. Default false.
   */
  TOOL_OUTPUT_SCREEN_ENABLED: boolean;
  /**
   * Max milliseconds for one live tool-output classification request.
   * Env: `TOOL_OUTPUT_SCREEN_TIMEOUT_MS`. Default 1500.
   */
  TOOL_OUTPUT_SCREEN_TIMEOUT_MS: number;
  /**
   * Max tool-output classify calls in flight at once for one turn's tool batch. The tool-output
   * screen previously classified results strictly one at a time, so a large parallel tool batch
   * paid the full round-trip latency per result; bounding the fan-out keeps the small local
   * classifier saturated without overwhelming it.
   * Env: `TOOL_OUTPUT_SCREEN_MAX_CONCURRENCY`. Default 4.
   */
  TOOL_OUTPUT_SCREEN_MAX_CONCURRENCY: number;
  /**
   * How long a cached classifier verdict stays valid. Both the recall screen and the tool-output
   * screen classify through the same sidecar, and the same memories and tool outputs recur across
   * turns, so a process-wide cache of successful `/classify` verdicts (keyed by classifier URL,
   * threshold, and exact text) avoids re-paying a network round trip plus a model run for a
   * verdict that cannot change. Only `ok` verdicts are cached; timeouts and errors are retried.
   * Env: `SCREEN_CLASSIFY_CACHE_TTL_MS`. Default 300000 (5 minutes).
   */
  SCREEN_CLASSIFY_CACHE_TTL_MS: number;
  /**
   * Maximum cached classifier verdicts; the oldest entry is evicted past this.
   * Env: `SCREEN_CLASSIFY_CACHE_MAX_ENTRIES`. Default 2000.
   */
  SCREEN_CLASSIFY_CACHE_MAX_ENTRIES: number;
  /**
   * Whether the pre-recall gate may skip the memory provider reads on high-confidence trivial
   * turns (short greetings, bare acknowledgements). Off by default; a bank can override it in
   * Settings > Memory. Env: `MEMORY_PRERECALL_GATE_ENABLED`. Default false.
   */
  MEMORY_PRERECALL_GATE_ENABLED: boolean;
  /**
   * Whether every turn also injects the memory bank's curated layer: its profile and the mental
   * models relevant to the recall query. Cheap reads with no model call behind them.
   * Env: `MEMORY_CURATED_ENABLED`. Default true.
   */
  MEMORY_CURATED_ENABLED: boolean;
  /**
   * Most mental models injected on one turn. Env: `MEMORY_CURATED_MAX_MODELS`. Default 3.
   */
  MEMORY_CURATED_MAX_MODELS: number;
  /**
   * Token budget for the injected mental-model lines, taken out of `MEMORY_RECALL_MAX_TOKENS`.
   * Env: `MEMORY_CURATED_MAX_TOKENS`. Default 512.
   */
  MEMORY_CURATED_MAX_TOKENS: number;
  /**
   * Whether a synthesis-shaped user message (summarize, brief me, recommend, compare, what should I
   * do) also asks the memory provider to reflect and injects its answer. Reflect spends model calls
   * on the local inference server; factual questions never take this route.
   * Env: `MEMORY_REFLECT_ENABLED`. Default true.
   */
  MEMORY_REFLECT_ENABLED: boolean;
  /**
   * Reflect effort: `low` (one pass), `mid`, or `high`. Env: `MEMORY_REFLECT_BUDGET`. Default low.
   */
  MEMORY_REFLECT_BUDGET: ReflectBudget;
  /**
   * Which long-term memory backend Aman uses. `markdown` (the default) stores memories as
   * local Markdown files (OpenClaw-style, no server required) and is the stable, supported
   * path. `hindsight` uses the Hindsight REST API via the MCP server flagged as the memory
   * provider; it is EXPERIMENTAL and retained for rollback only, not supported.
   * Env: `MEMORY_BACKEND`. Default `markdown`.
   */
  MEMORY_BACKEND: MemoryBackend;
  /**
   * Base directory for the markdown memory backend. Each tenant gets a sanitized
   * subdirectory. Only consulted when `MEMORY_BACKEND` is `markdown`.
   * Env: `MEMORY_MARKDOWN_DIR`. Default `./data/memory` (relative to the process cwd).
   */
  MEMORY_MARKDOWN_DIR: string;
  /**
   * When true, the markdown memory backend summarizes each turn via the LLM before writing
   * it to the daily log, instead of appending the verbatim User:/Assistant: transcript.
   * Summarization failures fall back to the verbatim transcript so a memory is never lost.
   * Only consulted when `MEMORY_BACKEND` is `markdown`.
   * Env: `MEMORY_SUMMARIZE`. Default `true`.
   */
  MEMORY_SUMMARIZE: boolean;
  /**
   * Nebius Token Factory API key. Populated from the Secure Vault into the deployment
   * environment; never committed or logged. With a key set, startup also writes a read-only
   * `tokenfactory` provider and makes its default model the chat default.
   * Env: `NEBIUS_API_KEY`. Unset by default.
   */
  NEBIUS_API_KEY: string | undefined;
  /**
   * Token Factory model id used for fallback and forced routing.
   * Env: `TOKEN_FACTORY_MODEL`. Default `nvidia/nemotron-3-super-120b-a12b`.
   */
  TOKEN_FACTORY_MODEL: string;
  /**
   * Optional cheaper Token Factory model registered next to the default on the env-managed
   * provider. Set it to an empty string to register only the default model.
   * Env: `TOKEN_FACTORY_CHEAPER_MODEL`. Default `openai/gpt-oss-120b`.
   */
  TOKEN_FACTORY_CHEAPER_MODEL: string | undefined;
  /**
   * Token Factory base URL.
   * Env: `TOKEN_FACTORY_BASE_URL`. Default `https://api.tokenfactory.nebius.com/v1`.
   */
  TOKEN_FACTORY_BASE_URL: string;
  /**
   * How turns may route to Nebius Token Factory. `off` (the default) disables Token
   * Factory routing entirely. `fallback` uses the configured local provider first and
   * fails over to Token Factory when it is unavailable. `force` uses Token Factory
   * first with the local provider as fallback, for testing and demo paths; it sends
   * prompts to the cloud first, so it is not local-first. Routing is a no-op when the
   * chat model already is on Token Factory.
   * Env: `TOKEN_FACTORY_MODE`. Default `off`.
   */
  TOKEN_FACTORY_MODE: TokenFactoryMode;
  /**
   * Daily Token Factory token budget per instance, counted per UTC day from provider-reported
   * usage. Once reached, new turns on Token Factory are refused until the next UTC day.
   * Env: `TOKEN_FACTORY_DAILY_TOKEN_CAP`. Unset means no cap.
   */
  TOKEN_FACTORY_DAILY_TOKEN_CAP: number | undefined;
  /**
   * Marks this instance as a demo. Only `aman demo-seed` reads it: the seed refuses to run
   * unless it is true, so it can never touch a real instance.
   * Env: `DEMO_MODE`. Default false.
   */
  DEMO_MODE: boolean;
  /**
   * Meaning-based recall for the markdown backend. When true, the server downloads
   * a small embedding model once (~120 MB, in the background) and uses it to find
   * memories by meaning in addition to keyword overlap. Everything runs on the
   * server; when the model is unavailable, recall silently stays keyword-only.
   * Env: `MEMORY_EMBEDDINGS_ENABLED`. Default true.
   */
  MEMORY_EMBEDDINGS_ENABLED: boolean;
  /**
   * Directory where the embedding model is downloaded once and cached. Persist it
   * (Docker volume) or every restart re-downloads ~120 MB.
   * Env: `MEMORY_EMBEDDINGS_MODEL_DIR`. Default `<MEMORY_MARKDOWN_DIR>/.embedding-model`.
   */
  MEMORY_EMBEDDINGS_MODEL_DIR: string;
  /**
   * Root directory for persona knowledge libraries. Each persona gets its own
   * SQLite database file under a sanitized tenant subdirectory, so knowledge
   * can never leak across personas. Persist it (Docker volume) or libraries
   * vanish on container recreate.
   * Env: `PERSONA_KNOWLEDGE_DIR`. Default `./data/persona-knowledge` (relative to the process cwd).
   */
  PERSONA_KNOWLEDGE_DIR: string;
  /**
   * Memories embedded per background-backfill batch. Smaller batches yield to the
   * event loop more often; larger batches finish sooner.
   * Env: `MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE`. Default 8.
   */
  MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE: number;
  /**
   * Max tokens the provider may spend on a reflect answer. Env: `MEMORY_REFLECT_MAX_TOKENS`.
   * Default 512.
   */
  MEMORY_REFLECT_MAX_TOKENS: number;
  /**
   * Max milliseconds to wait for a reflect answer before the turn proceeds without it. Capped at
   * the shared memory deadline maximum (120000); a larger value fails fast at startup.
   * Env: `MEMORY_REFLECT_TIMEOUT_MS`. Default 8000.
   */
  MEMORY_REFLECT_TIMEOUT_MS: number;
  /**
   * Model FQN (`provider/model`) for the distillation pass. Empty means the
   * turn's own model. Env: `PROFILE_LEARNING_MODEL`. Default empty.
   * Whether the pass runs at all is the user's, on the personalization profile.
   */
  PROFILE_LEARNING_MODEL: string;
  /**
   * Min milliseconds between host-written learned-profile updates.
   * Env: `PROFILE_LEARNING_MIN_INTERVAL_MS`. Default 3600000 (1 hour).
   */
  PROFILE_LEARNING_MIN_INTERVAL_MS: number;
  /**
   * Space-separated Tesseract language codes for OCR operations.
   * Default `eng hin mar` (English, Hindi, Marathi), which the shipped sandbox image carries; joined with + for tesseract -l. Env: `DOCUMENT_OCR_LANGUAGES`.
   */
  DOCUMENT_OCR_LANGUAGES: string;
  /**
   * Base URL the controller uses to reach the server's HTTP API. Dedicated controller
   * (`STANDALONE=false`, `dist/controller-main.js`) and the in-process standalone controller
   * both call the server over HTTP(S) at this URL (loopback in standalone). When
   * `TRUEFORGE_MTLS_ENABLED` is true the controller upgrades an `http://` URL to `https://`
   * and presents the client cert. Env: `SERVER_URL`.
   * Default: `http://localhost:$PORT`; in-cluster deployments MUST point this at the server Service.
   */
  SERVER_URL: string;
  /**
   * Service credential for controller calls.
   * Env: `TRUEFORGE_API_KEY`. When `STANDALONE=false` and unset, falls back to a well-known placeholder.
   * Standalone refuses placeholders and generates a fresh random key at process start when unset (local only).
   */
  TRUEFORGE_API_KEY: string;
  /**
   * Mutual TLS for this process's HTTPS listener and controller→server. When true, serves HTTPS
   * with client-cert enforcement (except `/healthz`) and the controller presents a client cert.
   * Env: `TRUEFORGE_MTLS_ENABLED`. Default false.
   */
  TRUEFORGE_MTLS_ENABLED: boolean;
  /**
   * Directory holding the TLS cert triple (`tls.crt` / `tls.key` / `ca.crt`) when
   * `TRUEFORGE_MTLS_ENABLED` is true. Env: `TRUEFORGE_MTLS_CERTS_DIR`. Default `/etc/tls`.
   */
  TRUEFORGE_MTLS_CERTS_DIR: string;
}

export type StandaloneServerConfiguration = SharedServerConfiguration & {
  /**
   * Single-process topology: SQLite persistence, no Redis / executor peering.
   * Env: `STANDALONE`. Default: true.
   */
  STANDALONE: true;
  /**
   * Absolute SQLite database file path.
   * Env: `SQLITE_PATH` (optional). Default: env-paths data dir + `db/db.sqlite`.
   */
  SQLITE_PATH: string;
  /**
   * Parent directory for local sandbox roots (ULID children).
   * Derived: `{app data dir}/sandboxes`.
   */
  LOCAL_SANDBOX_ROOT_PARENT: string;
  /**
   * Parent directory for Code Mode UDS sockets (`tf_cms_<port>` under os.tmpdir()).
   * Caller prepares/removes this directory; must stay ≤65 bytes after realpath.
   */
  CODE_MODE_SOCKET_PARENT: string;
};

export type DistributedServerConfiguration = SharedServerConfiguration & {
  /**
   * Multi-replica topology: Postgres persistence + Redis executor peering.
   * Env: `STANDALONE`. Default: true (so this branch requires an explicit `false`).
   */
  STANDALONE: false;
  /**
   * Postgres connection string. Env: `DATABASE_URL` when set; otherwise built from `POSTGRES_*`
   * (including optional `POSTGRES_SSL_MODE` as `sslmode`).
   * Form: `postgres://USER:PASSWORD@HOST:PORT/DB` (or `postgresql://…`) with user/password URL-encoded.
   */
  DATABASE_URL: string;
  /** Max connections in the `pg` Pool. Env: `DATABASE_POOL_MAX`. Default 10. */
  DATABASE_POOL_MAX: number;
  /**
   * Postgres `statement_timeout` for app and migrations (same pool).
   * Env: `POSTGRES_STATEMENT_TIMEOUT_MS`. Default 60000.
   */
  POSTGRES_STATEMENT_TIMEOUT_MS: number;
  /**
   * Postgres `idle_in_transaction_session_timeout` for app and migrations (same pool).
   * Env: `POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS`. Default 60000.
   */
  POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: number;
  /** Peering URL shared by all replicas. Env: `REDIS_URL`. Default `redis://localhost:6379`. */
  REDIS_URL: string;
  /**
   * When set, models/MCP/agents are backed by the TrueFoundry ServiceFoundry server with the
   * caller's token. Unset = local Postgres stores. Mutually exclusive with OIDC.
   * Env: `TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL`.
   */
  TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL: string | undefined;
  /**
   * Required when `TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL` is set. Env: `TRUEFOUNDRY_API_KEY`.
   */
  TRUEFOUNDRY_API_KEY: string | undefined;
  /** Max ms for non-agent ServiceFoundry HTTP calls. Env: `TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_TIMEOUT_MS`. Default 10000. */
  TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_TIMEOUT_MS: number;
  /** Max ms for agent CRUD ServiceFoundry HTTP calls. Env: `TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_AGENT_TIMEOUT_MS`. Default 3000. */
  TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_AGENT_TIMEOUT_MS: number;
  /**
   * Present this pod's client certificate on outbound calls to the ServiceFoundry server (internal
   * mutual TLS) and upgrade a mesh-direct peer URL from http to https. Off by default, so an
   * unconfigured deployment keeps calling over plain HTTP exactly as before.
   * Env: `TRUEFOUNDRY_MTLS_ENABLED`. Default false.
   */
  TRUEFOUNDRY_MTLS_ENABLED: boolean;
  /**
   * Directory holding the internal mTLS material used when `TRUEFOUNDRY_MTLS_ENABLED` is true — the
   * cert triple `tls.crt` / `tls.key` / `ca.crt`, so one chart value configures every component.
   * Env: `TRUEFOUNDRY_MTLS_CERTS_DIR`. Default `/etc/tls/truefoundry`.
   */
  TRUEFOUNDRY_MTLS_CERTS_DIR: string;
  /**
   * When TrueFoundry mode is on, enable the shared sandbox for all tenants
   * (no per-tenant PUT). Env: `TRUEFOUNDRY_SANDBOX_ENABLED`. Default false.
   */
  TRUEFOUNDRY_SANDBOX_ENABLED: boolean;
  /**
   * Shared sandbox backend when `TRUEFOUNDRY_SANDBOX_ENABLED` is true.
   * Env: `TRUEFOUNDRY_SANDBOX_PROVIDER` (`daytona` | `truefoundry`).
   */
  TRUEFOUNDRY_SANDBOX_PROVIDER: 'daytona' | 'truefoundry' | undefined;
  /**
   * Shared API key (required for Daytona; optional for truefoundry).
   * Env: `TRUEFOUNDRY_SANDBOX_API_KEY`.
   */
  TRUEFOUNDRY_SANDBOX_API_KEY: string | undefined;
  /**
   * TrueFoundry (on-prem) sandbox HTTP server URL when provider is `truefoundry`.
   * Env: `TRUEFOUNDRY_SANDBOX_SERVER_URL`.
   */
  TRUEFOUNDRY_SANDBOX_SERVER_URL: string | undefined;
  /**
   * Static JSON settings for the shared sandbox (provider-specific).
   * Daytona: `snapshotName`, intervals, `timeoutMs`. TrueFoundry: `nats_bridge_url`.
   * Env: `TRUEFOUNDRY_SANDBOX_SETTINGS`.
   */
  TRUEFOUNDRY_SANDBOX_SETTINGS: string | undefined;
};

export type ServerConfiguration = StandaloneServerConfiguration | DistributedServerConfiguration;

// ============================================================================
// CONFIGURATION VALUES
// ============================================================================

const serverExecutionTimeoutSeconds = parsePositiveInt({
  envKey: 'SERVER_EXECUTION_TIMEOUT_SECONDS',
  raw: getEnv('SERVER_EXECUTION_TIMEOUT_SECONDS'),
  // Must stay above run_code's dispatch deadline (getRunCodeToolCallTimeoutMs); see its comment.
  defaultValue: 1380,
});

const standalone = parseBoolean({
  envKey: 'STANDALONE',
  raw: getEnv('STANDALONE'),
  defaultValue: true,
});

/**
 * Root for SQLite, sandbox roots, sandbox state and the git bridge.
 * Env: `APP_DATA_DIR` (optional absolute path). Default: the env-paths data dir, which sits under the
 * home directory. Images that run as a user with no home set this to a path on the data volume.
 */
export function resolveAppDataDir({ override, suffix }: { override: string | undefined; suffix: string }): string {
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override);
  }
  return envPaths(ENV_PATHS_APP_NAME, { suffix }).data;
}

const appDataDir = resolveAppDataDir({
  override: getEnv('APP_DATA_DIR'),
  suffix: getEnv('APP_DATA_DIR_SUFFIX', { defaultValue: '' }) ?? '',
});

const port = parsePort(getEnv('PORT'));
const host = getEnv('HOST', { defaultValue: DEFAULT_HOST }) ?? DEFAULT_HOST;

const shared: SharedServerConfiguration = {
  LOG_LEVEL: getEnv('LOG_LEVEL', { defaultValue: 'info' }) ?? 'info',
  ACCESS_LOGS: parseBoolean({ envKey: 'ACCESS_LOGS', raw: getEnv('ACCESS_LOGS'), defaultValue: true }),
  NODE_ENV: getEnv('NODE_ENV'),
  BUILD_REF: parseBuildRef(getEnv('BUILD_REF')),
  BUG_REPORT_HANDOFF_URL: parseHandoffUrl(getEnv('BUG_REPORT_HANDOFF_URL')),
  PORT: port,
  HOST: host,
  REQUIRE_AUTH: parseBoolean({ envKey: 'REQUIRE_AUTH', raw: getEnv('REQUIRE_AUTH'), defaultValue: true }),
  OIDC: resolveOIDCConfig(),
  AUTH_COOKIE_SUFFIX: parseAuthCookieSuffix(getEnv('AUTH_COOKIE_SUFFIX')),
  EXECUTOR_ID: standalone ? LOCAL_EXECUTOR_ID : randomAlphanumeric(6),
  MODEL_CATALOG_PATH: resolveOptionalPathEnv('MODEL_CATALOG_PATH'),
  MCP_CATALOG_PATH: resolveOptionalPathEnv('MCP_CATALOG_PATH'),
  SKILL_CATALOG_PATH: resolveOptionalPathEnv('SKILL_CATALOG_PATH'),
  SANDBOX_CATALOG_PATH: resolveOptionalPathEnv('SANDBOX_CATALOG_PATH'),
  FRONTEND_DIR: resolveFrontendDir(),

  MCP_REQUEST_TIMEOUT_MS: parsePositiveInt({
    envKey: 'MCP_REQUEST_TIMEOUT_MS',
    raw: getEnv('MCP_REQUEST_TIMEOUT_MS'),
    defaultValue: 4 * 60 * 1000,
  }),
  MCP_CONNECT_TIMEOUT_MS: parsePositiveInt({
    envKey: 'MCP_CONNECT_TIMEOUT_MS',
    raw: getEnv('MCP_CONNECT_TIMEOUT_MS'),
    defaultValue: 30 * 1000,
  }),
  FIRST_PARTY_MCP_ORIGINS: parseFirstPartyMcpOrigins(getEnv('FIRST_PARTY_MCP_ORIGINS')),
  TOOL_DISPATCH_MAX_CONCURRENCY: parsePositiveInt({
    envKey: 'TOOL_DISPATCH_MAX_CONCURRENCY',
    raw: getEnv('TOOL_DISPATCH_MAX_CONCURRENCY'),
    // Literal mirror of DEFAULT_TOOL_DISPATCH_MAX_CONCURRENCY in
    // trueforge-core's executeToolCalls.ts (the canonical owner); kept inline
    // so config does not grow a new cross-package export for the default.
    defaultValue: 4,
  }),
  TOOL_CALL_TIMEOUT_MS: parsePositiveInt({
    envKey: 'TOOL_CALL_TIMEOUT_MS',
    raw: getEnv('TOOL_CALL_TIMEOUT_MS'),
    // Literal mirror of DEFAULT_TOOL_CALL_TIMEOUT_MS in trueforge-core's
    // executeToolCalls.ts; must stay below SERVER_EXECUTION_TIMEOUT_SECONDS.
    // the normal per-tool-call ceiling. run_code alone gets the provisioning-sized
    // deadline (see getRunCodeToolCallTimeoutMs), so the long bound is scoped
    // to the one tool that needs it instead of every tool.
    defaultValue: 240_000,
  }),
  MODEL_FIRST_RESPONSE_TIMEOUT_MS: parsePositiveInt({
    envKey: 'MODEL_FIRST_RESPONSE_TIMEOUT_MS',
    raw: getEnv('MODEL_FIRST_RESPONSE_TIMEOUT_MS'),
    // Literal mirror of DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS in
    // trueforge-core's AgentThread.ts (the canonical owner).
    defaultValue: 600_000,
  }),
  MCP_DCR_OAUTH_CLIENT_NAME:
    getEnv('MCP_DCR_OAUTH_CLIENT_NAME', { defaultValue: 'truefoundry-harness' }) ?? 'truefoundry-harness',
  SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD: parsePositiveInt({
    envKey: 'SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD',
    raw: getEnv('SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD'),
    defaultValue: 26_214_400,
  }),
  SANDBOX_ISOLATION_DRIVER: parseIsolationDriver({
    envKey: 'SANDBOX_ISOLATION_DRIVER',
    raw: getEnv('SANDBOX_ISOLATION_DRIVER'),
    defaultValue: 'docker',
  }),
  SANDBOX_BACKEND: parseSandboxBackend({ envKey: 'SANDBOX_BACKEND', raw: getEnv('SANDBOX_BACKEND') }),
  SANDBOX_SLOTS: parsePositiveInt({
    envKey: 'SANDBOX_SLOTS',
    raw: getEnv('SANDBOX_SLOTS'),
    defaultValue: SANDBOX_MAX_SLOTS,
  }),
  SANDBOX_SLOTS_DIR: getEnv('SANDBOX_SLOTS_DIR', { defaultValue: '' }) ?? '',
  SANDBOX_SESSION_DISK_MB: parsePositiveInt({
    envKey: 'SANDBOX_SESSION_DISK_MB',
    raw: getEnv('SANDBOX_SESSION_DISK_MB'),
    defaultValue: 2048,
  }),
  SANDBOX_IMAGE: getEnv('SANDBOX_IMAGE', { defaultValue: '' }) ?? '',
  SANDBOX_RUNS_DIR: path.join(appDataDir, 'sandbox-runs'),
  SANDBOX_STATE_DIR: path.join(appDataDir, 'sandbox-state'),
  SANDBOX_GIT_BRIDGE_DIR: path.join(appDataDir, 'git-bridge'),
  SANDBOX_GIT_NETWORK_ENV: pickGitNetworkEnv(
    Object.fromEntries(GIT_NETWORK_ENV_NAMES.map(name => [name, getEnv(name)])),
  ),
  SANDBOX_DEFAULT_TIMEOUT_SECONDS: parsePositiveInt({
    envKey: 'SANDBOX_DEFAULT_TIMEOUT_SECONDS',
    raw: getEnv('SANDBOX_DEFAULT_TIMEOUT_SECONDS'),
    defaultValue: 60,
  }),
  SANDBOX_MAX_TIMEOUT_SECONDS: parsePositiveInt({
    envKey: 'SANDBOX_MAX_TIMEOUT_SECONDS',
    raw: getEnv('SANDBOX_MAX_TIMEOUT_SECONDS'),
    defaultValue: 600,
  }),
  SANDBOX_MEMORY_MB: parsePositiveInt({
    envKey: 'SANDBOX_MEMORY_MB',
    raw: getEnv('SANDBOX_MEMORY_MB'),
    defaultValue: 2048,
  }),
  SANDBOX_DISK_MB: parsePositiveInt({
    envKey: 'SANDBOX_DISK_MB',
    raw: getEnv('SANDBOX_DISK_MB'),
    defaultValue: 1024,
  }),
  SANDBOX_STDOUT_STDERR_CAP_KB: parsePositiveInt({
    envKey: 'SANDBOX_STDOUT_STDERR_CAP_KB',
    raw: getEnv('SANDBOX_STDOUT_STDERR_CAP_KB'),
    defaultValue: 256,
  }),
  SANDBOX_IMAGE_PULL_TIMEOUT_SECONDS: parsePositiveInt({
    envKey: 'SANDBOX_IMAGE_PULL_TIMEOUT_SECONDS',
    raw: getEnv('SANDBOX_IMAGE_PULL_TIMEOUT_SECONDS'),
    defaultValue: 600,
  }),
  SANDBOX_NETWORK_EGRESS: parseBoolean({
    envKey: 'SANDBOX_NETWORK_EGRESS',
    raw: getEnv('SANDBOX_NETWORK_EGRESS'),
    defaultValue: false,
  }),
  SANDBOX_COSIGN_PUBLIC_KEY_PATH: getEnv('SANDBOX_COSIGN_PUBLIC_KEY_PATH', { defaultValue: '' }) ?? '',
  TURN_ARTIFACT_RETENTION_DAYS: parsePositiveInt({
    envKey: 'TURN_ARTIFACT_RETENTION_DAYS',
    raw: getEnv('TURN_ARTIFACT_RETENTION_DAYS'),
    defaultValue: 30,
  }),
  SANDBOX_FIRECRACKER_KVM_DEVICE: getEnv('SANDBOX_FIRECRACKER_KVM_DEVICE', { defaultValue: '/dev/kvm' }) ?? '/dev/kvm',
  SANDBOX_FIRECRACKER_KERNEL: getEnv('SANDBOX_FIRECRACKER_KERNEL', { defaultValue: '' }) ?? '',
  SANDBOX_FIRECRACKER_ROOTFS: getEnv('SANDBOX_FIRECRACKER_ROOTFS', { defaultValue: '' }) ?? '',
  SANDBOX_FIRECRACKER_SNAPSHOT_ENABLED: parseBoolean({
    envKey: 'SANDBOX_FIRECRACKER_SNAPSHOT_ENABLED',
    raw: getEnv('SANDBOX_FIRECRACKER_SNAPSHOT_ENABLED'),
    defaultValue: false,
  }),
  MAX_REQUEST_BODY_BYTES: parsePositiveInt({
    envKey: 'MAX_REQUEST_BODY_BYTES',
    raw: getEnv('MAX_REQUEST_BODY_BYTES'),
    defaultValue: DEFAULT_MAX_REQUEST_BODY_BYTES,
  }),
  DATA_EXPORT_MAX_BYTES: parsePositiveInt({
    envKey: 'DATA_EXPORT_MAX_BYTES',
    raw: getEnv('DATA_EXPORT_MAX_BYTES'),
    defaultValue: 1024 * 1024 * 1024,
  }),
  CONTEXT_COMPACTION_THRESHOLD_TOKENS: parseOptionalPositiveInt({
    envKey: 'CONTEXT_COMPACTION_THRESHOLD_TOKENS',
    raw: getEnv('CONTEXT_COMPACTION_THRESHOLD_TOKENS'),
  }),
  GRACEFUL_TIMEOUT_SECONDS: parsePositiveInt({
    envKey: 'GRACEFUL_TIMEOUT_SECONDS',
    raw: getEnv('GRACEFUL_TIMEOUT_SECONDS'),
    defaultValue: 30,
  }),
  TURN_DRAIN_SHUTDOWN_TIMEOUT_MS: parsePositiveInt({
    envKey: 'TURN_DRAIN_SHUTDOWN_TIMEOUT_MS',
    raw: getEnv('TURN_DRAIN_SHUTDOWN_TIMEOUT_MS'),
    defaultValue: 30_000,
  }),
  SERVER_EXECUTION_TIMEOUT_SECONDS: serverExecutionTimeoutSeconds,
  TURN_STREAM_TTL_SECONDS: parsePositiveInt({
    envKey: 'TURN_STREAM_TTL_SECONDS',
    raw: getEnv('TURN_STREAM_TTL_SECONDS'),
    defaultValue: serverExecutionTimeoutSeconds + 300,
  }),
  TURN_STREAM_POST_COMPLETION_TTL_SECONDS: parsePositiveInt({
    envKey: 'TURN_STREAM_POST_COMPLETION_TTL_SECONDS',
    raw: getEnv('TURN_STREAM_POST_COMPLETION_TTL_SECONDS'),
    defaultValue: 300,
  }),
  TURN_SUBSCRIBE_TIMEOUT_MS: parsePositiveInt({
    envKey: 'TURN_SUBSCRIBE_TIMEOUT_MS',
    raw: getEnv('TURN_SUBSCRIBE_TIMEOUT_MS'),
    defaultValue: 600_000,
  }),
  REDIS_REQUEST_REPLY_TIMEOUT_MS: parsePositiveInt({
    envKey: 'REDIS_REQUEST_REPLY_TIMEOUT_MS',
    raw: getEnv('REDIS_REQUEST_REPLY_TIMEOUT_MS'),
    defaultValue: 60_000,
  }),
  REDIS_REQUEST_REPLY_HEARTBEAT_INTERVAL_MS: parsePositiveInt({
    envKey: 'REDIS_REQUEST_REPLY_HEARTBEAT_INTERVAL_MS',
    raw: getEnv('REDIS_REQUEST_REPLY_HEARTBEAT_INTERVAL_MS'),
    defaultValue: 5_000,
  }),
  REDIS_REQUEST_REPLY_REPLY_TTL_MS: parsePositiveInt({
    envKey: 'REDIS_REQUEST_REPLY_REPLY_TTL_MS',
    raw: getEnv('REDIS_REQUEST_REPLY_REPLY_TTL_MS'),
    defaultValue: 120_000,
  }),
  REDIS_REQUEST_REPLY_POLL_INTERVAL_MS: parsePositiveInt({
    envKey: 'REDIS_REQUEST_REPLY_POLL_INTERVAL_MS',
    raw: getEnv('REDIS_REQUEST_REPLY_POLL_INTERVAL_MS'),
    defaultValue: 500,
  }),
  MEMORY_RECALL_MAX_TOKENS: parsePositiveInt({
    envKey: 'MEMORY_RECALL_MAX_TOKENS',
    raw: getEnv('MEMORY_RECALL_MAX_TOKENS'),
    defaultValue: 2048,
  }),
  MEMORY_RECALL_ENTITY_TOKENS: parsePositiveInt({
    envKey: 'MEMORY_RECALL_ENTITY_TOKENS',
    raw: getEnv('MEMORY_RECALL_ENTITY_TOKENS'),
    defaultValue: 512,
  }),
  MEMORY_RECALL_TIMEOUT_MS: parsePositiveInt({
    envKey: 'MEMORY_RECALL_TIMEOUT_MS',
    raw: getEnv('MEMORY_RECALL_TIMEOUT_MS'),
    defaultValue: 2500,
    maxValue: MEMORY_PROVIDER_MAX_TIMEOUT_MS,
  }),
  MEMORY_RECALL_QUERY_WINDOW: parsePositiveInt({
    envKey: 'MEMORY_RECALL_QUERY_WINDOW',
    raw: getEnv('MEMORY_RECALL_QUERY_WINDOW'),
    defaultValue: 5,
  }),
  MEMORY_RECALL_MIN_SCORE: parseUnitInterval({
    envKey: 'MEMORY_RECALL_MIN_SCORE',
    raw: getEnv('MEMORY_RECALL_MIN_SCORE'),
    defaultValue: 0.5,
  }),
  MEMORY_RECALL_MAX_ITEMS: parsePositiveInt({
    envKey: 'MEMORY_RECALL_MAX_ITEMS',
    raw: getEnv('MEMORY_RECALL_MAX_ITEMS'),
    defaultValue: 12,
  }),
  MEMORY_RECALL_MAX_ENTITIES: parsePositiveInt({
    envKey: 'MEMORY_RECALL_MAX_ENTITIES',
    raw: getEnv('MEMORY_RECALL_MAX_ENTITIES'),
    defaultValue: 8,
    minValue: MEMORY_SETTINGS_LIMITS.recallMaxEntities.min,
    maxValue: MEMORY_SETTINGS_LIMITS.recallMaxEntities.max,
  }),
  MEMORY_RETAIN_TIMEOUT_MS: parsePositiveInt({
    envKey: 'MEMORY_RETAIN_TIMEOUT_MS',
    raw: getEnv('MEMORY_RETAIN_TIMEOUT_MS'),
    defaultValue: 10_000,
  }),
  MEMORY_MAX_RESPONSE_BYTES: parsePositiveInt({
    envKey: 'MEMORY_MAX_RESPONSE_BYTES',
    raw: getEnv('MEMORY_MAX_RESPONSE_BYTES'),
    defaultValue: 524_288,
  }),
  MEMORY_SWEEP_MAX_PER_TURN: parsePositiveInt({
    envKey: 'MEMORY_SWEEP_MAX_PER_TURN',
    raw: getEnv('MEMORY_SWEEP_MAX_PER_TURN'),
    defaultValue: 5,
  }),
  MEMORY_CHECK_TIMEOUT_MS: parsePositiveInt({
    envKey: 'MEMORY_CHECK_TIMEOUT_MS',
    raw: getEnv('MEMORY_CHECK_TIMEOUT_MS'),
    defaultValue: 5000,
    maxValue: MEMORY_PROVIDER_MAX_TIMEOUT_MS,
  }),
  MEMORY_SCREEN_ENABLED: parseBoolean({
    envKey: 'MEMORY_SCREEN_ENABLED',
    raw: getEnv('MEMORY_SCREEN_ENABLED'),
    defaultValue: false,
  }),
  MEMORY_SCREEN_URL: getEnv('MEMORY_SCREEN_URL', { defaultValue: '' }) ?? '',
  STT_URL: getEnv('STT_URL', { defaultValue: 'http://aman-stt:8001' }) ?? 'http://aman-stt:8001',
  MAPS_GEOCODER_URL: parseMapsUrl({
    envKey: 'MAPS_GEOCODER_URL',
    raw: getEnv('MAPS_GEOCODER_URL'),
    defaultValue: 'https://nominatim.openstreetmap.org',
  }),
  MAPS_ROUTER_PROVIDER: parseMapsRouterProvider(getEnv('MAPS_ROUTER_PROVIDER', { required: false })),
  MAPS_ROUTER_URL: parseMapsUrl({
    envKey: 'MAPS_ROUTER_URL',
    raw: getEnv('MAPS_ROUTER_URL'),
    defaultValue: 'https://router.project-osrm.org',
  }),
  MAPS_TILE_URL: parseMapsUrl({
    envKey: 'MAPS_TILE_URL',
    raw: getEnv('MAPS_TILE_URL'),
    defaultValue: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    requiredPlaceholders: ['{z}', '{x}', '{y}'],
  }),
  MAPS_USER_AGENT:
    getEnv('MAPS_USER_AGENT', { required: false }) ??
    `Amanuensis/${PACKAGE_VERSION} (+https://github.com/ClimbOutLabs/amanuensis)`,
  MEMORY_SCREEN_AUTH_TOKEN: getEnv('MEMORY_SCREEN_AUTH_TOKEN', { defaultValue: '' }) ?? '',
  MEMORY_SCREEN_THRESHOLD: parseUnitInterval({
    envKey: 'MEMORY_SCREEN_THRESHOLD',
    raw: getEnv('MEMORY_SCREEN_THRESHOLD'),
    defaultValue: 0.5,
  }),
  MEMORY_SCREEN_TIMEOUT_MS: parsePositiveInt({
    envKey: 'MEMORY_SCREEN_TIMEOUT_MS',
    raw: getEnv('MEMORY_SCREEN_TIMEOUT_MS'),
    defaultValue: 1500,
  }),
  MEMORY_SCREEN_MAX_CONCURRENCY: parsePositiveInt({
    envKey: 'MEMORY_SCREEN_MAX_CONCURRENCY',
    raw: getEnv('MEMORY_SCREEN_MAX_CONCURRENCY'),
    defaultValue: 8,
  }),
  TOOL_OUTPUT_SCREEN_ENABLED: parseBoolean({
    envKey: 'TOOL_OUTPUT_SCREEN_ENABLED',
    raw: getEnv('TOOL_OUTPUT_SCREEN_ENABLED'),
    defaultValue: false,
  }),
  TOOL_OUTPUT_SCREEN_TIMEOUT_MS: parsePositiveInt({
    envKey: 'TOOL_OUTPUT_SCREEN_TIMEOUT_MS',
    raw: getEnv('TOOL_OUTPUT_SCREEN_TIMEOUT_MS'),
    defaultValue: 1500,
  }),
  TOOL_OUTPUT_SCREEN_MAX_CONCURRENCY: parsePositiveInt({
    envKey: 'TOOL_OUTPUT_SCREEN_MAX_CONCURRENCY',
    raw: getEnv('TOOL_OUTPUT_SCREEN_MAX_CONCURRENCY'),
    defaultValue: 4,
  }),
  SCREEN_CLASSIFY_CACHE_TTL_MS: parsePositiveInt({
    envKey: 'SCREEN_CLASSIFY_CACHE_TTL_MS',
    raw: getEnv('SCREEN_CLASSIFY_CACHE_TTL_MS'),
    defaultValue: 300_000,
  }),
  SCREEN_CLASSIFY_CACHE_MAX_ENTRIES: parsePositiveInt({
    envKey: 'SCREEN_CLASSIFY_CACHE_MAX_ENTRIES',
    raw: getEnv('SCREEN_CLASSIFY_CACHE_MAX_ENTRIES'),
    defaultValue: 2000,
  }),
  MEMORY_PRERECALL_GATE_ENABLED: parseBoolean({
    envKey: 'MEMORY_PRERECALL_GATE_ENABLED',
    raw: getEnv('MEMORY_PRERECALL_GATE_ENABLED'),
    defaultValue: false,
  }),
  MEMORY_CURATED_ENABLED: parseBoolean({
    envKey: 'MEMORY_CURATED_ENABLED',
    raw: getEnv('MEMORY_CURATED_ENABLED'),
    defaultValue: true,
  }),
  MEMORY_CURATED_MAX_MODELS: parsePositiveInt({
    envKey: 'MEMORY_CURATED_MAX_MODELS',
    raw: getEnv('MEMORY_CURATED_MAX_MODELS'),
    defaultValue: 3,
  }),
  MEMORY_CURATED_MAX_TOKENS: parsePositiveInt({
    envKey: 'MEMORY_CURATED_MAX_TOKENS',
    raw: getEnv('MEMORY_CURATED_MAX_TOKENS'),
    defaultValue: 512,
  }),
  MEMORY_REFLECT_ENABLED: parseBoolean({
    envKey: 'MEMORY_REFLECT_ENABLED',
    raw: getEnv('MEMORY_REFLECT_ENABLED'),
    defaultValue: true,
  }),
  MEMORY_REFLECT_BUDGET: parseReflectBudget({
    envKey: 'MEMORY_REFLECT_BUDGET',
    raw: getEnv('MEMORY_REFLECT_BUDGET'),
    defaultValue: 'low',
  }),
  MEMORY_BACKEND: parseMemoryBackend({
    envKey: 'MEMORY_BACKEND',
    raw: getEnv('MEMORY_BACKEND'),
    defaultValue: 'markdown',
  }),
  MEMORY_MARKDOWN_DIR: getEnv('MEMORY_MARKDOWN_DIR', { defaultValue: './data/memory' }) ?? './data/memory',
  MEMORY_SUMMARIZE: parseBoolean({
    envKey: 'MEMORY_SUMMARIZE',
    raw: getEnv('MEMORY_SUMMARIZE'),
    defaultValue: true,
  }),
  NEBIUS_API_KEY: getEnv('NEBIUS_API_KEY'),
  TOKEN_FACTORY_MODEL:
    getEnv('TOKEN_FACTORY_MODEL', { defaultValue: DEFAULT_TOKEN_FACTORY_MODEL }) ?? DEFAULT_TOKEN_FACTORY_MODEL,
  TOKEN_FACTORY_CHEAPER_MODEL: blankToUndefined(
    getEnv('TOKEN_FACTORY_CHEAPER_MODEL', { defaultValue: DEFAULT_TOKEN_FACTORY_CHEAPER_MODEL }),
  ),
  TOKEN_FACTORY_BASE_URL:
    getEnv('TOKEN_FACTORY_BASE_URL', { defaultValue: TOKEN_FACTORY_DEFAULT_BASE_URL }) ??
    TOKEN_FACTORY_DEFAULT_BASE_URL,
  TOKEN_FACTORY_MODE: parseTokenFactoryMode({
    envKey: 'TOKEN_FACTORY_MODE',
    raw: getEnv('TOKEN_FACTORY_MODE'),
    defaultValue: 'off',
  }),
  TOKEN_FACTORY_DAILY_TOKEN_CAP: parseOptionalPositiveInt({
    envKey: 'TOKEN_FACTORY_DAILY_TOKEN_CAP',
    raw: getEnv('TOKEN_FACTORY_DAILY_TOKEN_CAP'),
  }),
  DEMO_MODE: parseBoolean({ envKey: 'DEMO_MODE', raw: getEnv('DEMO_MODE'), defaultValue: false }),
  MEMORY_EMBEDDINGS_ENABLED: parseBoolean({
    envKey: 'MEMORY_EMBEDDINGS_ENABLED',
    raw: getEnv('MEMORY_EMBEDDINGS_ENABLED'),
    defaultValue: true,
  }),
  MEMORY_EMBEDDINGS_MODEL_DIR:
    getEnv('MEMORY_EMBEDDINGS_MODEL_DIR') ??
    defaultEmbeddingModelDir(getEnv('MEMORY_MARKDOWN_DIR', { defaultValue: './data/memory' }) ?? './data/memory'),
  MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE: parsePositiveInt({
    envKey: 'MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE',
    raw: getEnv('MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE'),
    defaultValue: 8,
  }),
  PERSONA_KNOWLEDGE_DIR:
    getEnv('PERSONA_KNOWLEDGE_DIR', { defaultValue: './data/persona-knowledge' }) ?? './data/persona-knowledge',
  MEMORY_REFLECT_MAX_TOKENS: parsePositiveInt({
    envKey: 'MEMORY_REFLECT_MAX_TOKENS',
    raw: getEnv('MEMORY_REFLECT_MAX_TOKENS'),
    defaultValue: 512,
  }),
  MEMORY_REFLECT_TIMEOUT_MS: parsePositiveInt({
    envKey: 'MEMORY_REFLECT_TIMEOUT_MS',
    raw: getEnv('MEMORY_REFLECT_TIMEOUT_MS'),
    defaultValue: 8000,
    maxValue: MEMORY_PROVIDER_MAX_TIMEOUT_MS,
  }),
  PROFILE_LEARNING_MODEL: getEnv('PROFILE_LEARNING_MODEL', { defaultValue: '' }) ?? '',
  PROFILE_LEARNING_MIN_INTERVAL_MS: parsePositiveInt({
    envKey: 'PROFILE_LEARNING_MIN_INTERVAL_MS',
    raw: getEnv('PROFILE_LEARNING_MIN_INTERVAL_MS'),
    defaultValue: 3_600_000,
  }),
  DOCUMENT_OCR_LANGUAGES: getEnv('DOCUMENT_OCR_LANGUAGES', { defaultValue: 'eng hin mar' }) ?? 'eng hin mar',
  PUBLIC_BASE_URL: parsePublicBaseUrl(getEnv('PUBLIC_BASE_URL', { defaultValue: '' }), { allowPath: !standalone }),
  ALLOWED_ORIGINS: parseAllowedOrigins(getEnv('ALLOWED_ORIGINS', { defaultValue: '' })),
  LOGIN_UPSTREAM_URL: parseLoginUpstreamUrl(getEnv('LOGIN_UPSTREAM_URL', { defaultValue: '' })),
  TRUSTED_PROXY_ADDRESSES: parseTrustedProxyAddresses(getEnv('TRUSTED_PROXY_ADDRESSES', { defaultValue: '' })),
  SERVER_URL:
    getEnv('SERVER_URL', { defaultValue: `http://localhost:${String(port)}` }) ?? `http://localhost:${String(port)}`,
  TRUEFORGE_API_KEY: resolveTrueForgeApiKey({ standalone }),
  TRUEFORGE_MTLS_ENABLED: parseBoolean({
    envKey: 'TRUEFORGE_MTLS_ENABLED',
    raw: getEnv('TRUEFORGE_MTLS_ENABLED'),
    defaultValue: false,
  }),
  TRUEFORGE_MTLS_CERTS_DIR: getEnv('TRUEFORGE_MTLS_CERTS_DIR', { defaultValue: '/etc/tls' }) ?? '/etc/tls',
};

const configuration: ServerConfiguration = standalone
  ? {
      ...shared,
      STANDALONE: true,
      SQLITE_PATH: resolveSqlitePath(appDataDir),
      LOCAL_SANDBOX_ROOT_PARENT: resolveLocalSandboxRootParent(appDataDir),
      CODE_MODE_SOCKET_PARENT: resolveCodeModeSocketParent({ port }),
    }
  : {
      ...shared,
      STANDALONE: false,
      DATABASE_URL: resolvePostgresDatabaseUrl(),
      DATABASE_POOL_MAX: parsePositiveInt({
        envKey: 'DATABASE_POOL_MAX',
        raw: getEnv('DATABASE_POOL_MAX'),
        defaultValue: 10,
      }),
      POSTGRES_STATEMENT_TIMEOUT_MS: parsePositiveInt({
        envKey: 'POSTGRES_STATEMENT_TIMEOUT_MS',
        raw: getEnv('POSTGRES_STATEMENT_TIMEOUT_MS'),
        defaultValue: 60_000,
      }),
      POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: parsePositiveInt({
        envKey: 'POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS',
        raw: getEnv('POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS'),
        defaultValue: 60_000,
      }),
      REDIS_URL: resolveRedisUrl(),
      TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL: getEnv('TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL', { required: false }),
      TRUEFOUNDRY_API_KEY: getEnv('TRUEFOUNDRY_API_KEY', { required: false }),
      TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_TIMEOUT_MS: parsePositiveInt({
        envKey: 'TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_TIMEOUT_MS',
        raw: getEnv('TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_TIMEOUT_MS'),
        defaultValue: 10_000,
      }),
      TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_AGENT_TIMEOUT_MS: parsePositiveInt({
        envKey: 'TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_AGENT_TIMEOUT_MS',
        raw: getEnv('TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_AGENT_TIMEOUT_MS'),
        defaultValue: 3_000,
      }),
      TRUEFOUNDRY_MTLS_ENABLED: parseBoolean({
        envKey: 'TRUEFOUNDRY_MTLS_ENABLED',
        raw: getEnv('TRUEFOUNDRY_MTLS_ENABLED'),
        defaultValue: false,
      }),
      TRUEFOUNDRY_MTLS_CERTS_DIR:
        getEnv('TRUEFOUNDRY_MTLS_CERTS_DIR', { defaultValue: '/etc/tls/truefoundry' }) ?? '/etc/tls/truefoundry',
      TRUEFOUNDRY_SANDBOX_ENABLED: parseBoolean({
        envKey: 'TRUEFOUNDRY_SANDBOX_ENABLED',
        raw: getEnv('TRUEFOUNDRY_SANDBOX_ENABLED'),
        defaultValue: false,
      }),
      TRUEFOUNDRY_SANDBOX_PROVIDER: parseTrueFoundrySandboxProvider(
        getEnv('TRUEFOUNDRY_SANDBOX_PROVIDER', { required: false }),
      ),
      TRUEFOUNDRY_SANDBOX_API_KEY: getEnv('TRUEFOUNDRY_SANDBOX_API_KEY', { required: false }),
      TRUEFOUNDRY_SANDBOX_SERVER_URL: getEnv('TRUEFOUNDRY_SANDBOX_SERVER_URL', { required: false }),
      TRUEFOUNDRY_SANDBOX_SETTINGS: getEnv('TRUEFOUNDRY_SANDBOX_SETTINGS', { required: false }),
    };

/** The password a connection URL carries, decoded, or undefined when it has none or is not a URL. */
function urlPassword(raw: string): string | undefined {
  try {
    const password = decodeURIComponent(new URL(raw).password);
    return password === '' ? undefined : password;
  } catch {
    return undefined;
  }
}

/** The settings that carry secrets: what {@link getConfiguredSecretValues} reads, so a test can supply just these. */
export type ConfiguredSecretSettings = Pick<
  SharedServerConfiguration,
  'TRUEFORGE_API_KEY' | 'NEBIUS_API_KEY' | 'MEMORY_SCREEN_AUTH_TOKEN' | 'OIDC'
> &
  (
    | { STANDALONE: true }
    | ({ STANDALONE: false } & Pick<
        DistributedServerConfiguration,
        'TRUEFOUNDRY_API_KEY' | 'TRUEFOUNDRY_SANDBOX_API_KEY' | 'DATABASE_URL' | 'REDIS_URL'
      >)
  );

/**
 * Secret values this process holds from its own configuration, for the outbound secret guard:
 * service credentials, the OIDC client secret, and the passwords inside connection URLs. The one
 * place to extend when a new secret setting is added.
 */
export function getConfiguredSecretValues(config: ConfiguredSecretSettings = configuration): string[] {
  const candidates: (string | undefined)[] = [
    config.TRUEFORGE_API_KEY,
    config.NEBIUS_API_KEY,
    config.MEMORY_SCREEN_AUTH_TOKEN,
    config.OIDC?.OIDC_CLIENT_SECRET,
  ];
  if (!config.STANDALONE) {
    candidates.push(
      config.TRUEFOUNDRY_API_KEY,
      config.TRUEFOUNDRY_SANDBOX_API_KEY,
      config.DATABASE_URL,
      urlPassword(config.DATABASE_URL),
      config.REDIS_URL,
      urlPassword(config.REDIS_URL),
    );
  }
  return candidates.filter((value): value is string => value !== undefined && value !== '');
}

export function isOidcConfigured(value: ServerConfiguration): value is ServerConfiguration & { OIDC: OIDCConfig } {
  return value.OIDC !== undefined;
}

/**
 * TrueFoundry mode: ServiceFoundry-backed models/MCP/agents. Only available on
 * distributed config when `TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL` is set.
 */
export function isTrueFoundryModeEnabled(
  config: ServerConfiguration = configuration,
): config is DistributedServerConfiguration & { TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL: string } {
  return !config.STANDALONE && config.TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL !== undefined;
}

/** Runtime auth/integration mode for this process. */
export enum TrueForgeAuthMode {
  Standalone = 'standalone',
  Oidc = 'oidc',
  TrueFoundry = 'truefoundry',
}

/**
 * Resolve the active {@link TrueForgeAuthMode} from configuration.
 * TrueFoundry wins over OIDC when both would otherwise be set (startup already rejects that combo).
 */
export function getTrueForgeAuthMode(config: ServerConfiguration = configuration): TrueForgeAuthMode {
  if (isTrueFoundryModeEnabled(config)) {
    return TrueForgeAuthMode.TrueFoundry;
  }
  if (isOidcConfigured(config)) {
    return TrueForgeAuthMode.Oidc;
  }
  return TrueForgeAuthMode.Standalone;
}

/**
 * Normalise an IPv6 address by expanding ::, converting mixed IPv4 notation,
 * stripping zone IDs, and lowercasing. Assumes input is pre-validated by isIP(),
 * which guarantees well-formed IPv6 structure if called with validated input.
 */
function normaliseIpv6(addr: string): string {
  const parts = addr.split('%');
  const withoutZone = (parts[0] ?? '').toLowerCase();

  if (!withoutZone.includes(':')) {
    return withoutZone;
  }

  let processedAddr = withoutZone;
  const lastColon = withoutZone.lastIndexOf(':');
  const afterLastColon = withoutZone.substring(lastColon + 1);

  if (afterLastColon.includes('.')) {
    const ipv4Parts = afterLastColon.split('.');
    if (ipv4Parts.length === 4) {
      const num0 = parseInt(ipv4Parts[0] ?? '0', 10);
      const num1 = parseInt(ipv4Parts[1] ?? '0', 10);
      const num2 = parseInt(ipv4Parts[2] ?? '0', 10);
      const num3 = parseInt(ipv4Parts[3] ?? '0', 10);
      const hex1 = ((num0 << 8) | num1).toString(16).padStart(4, '0');
      const hex2 = ((num2 << 8) | num3).toString(16).padStart(4, '0');
      processedAddr = withoutZone.substring(0, lastColon) + ':' + hex1 + ':' + hex2;
    }
  }

  const addrParts = processedAddr.split(':');
  const doubleColonIndex = addrParts.findIndex((p, i) => p === '' && (addrParts[i + 1] ?? '') === '');

  if (doubleColonIndex === -1) {
    return addrParts.map(g => g.padStart(4, '0')).join(':');
  }

  const beforeDoubleColon = addrParts.slice(0, doubleColonIndex);
  const afterDoubleColon = addrParts.slice(doubleColonIndex + 2);
  const missingGroups = 8 - (beforeDoubleColon.length + afterDoubleColon.length);
  const missingGroupsArray: string[] = [];
  for (let i = 0; i < Math.max(0, missingGroups); i += 1) {
    missingGroupsArray.push('0000');
  }
  const expanded = [...beforeDoubleColon, ...missingGroupsArray, ...afterDoubleColon];

  return expanded.map(g => g.padStart(4, '0')).join(':');
}

/**
 * Check if an IPv4 address is in the loopback range (127.0.0.0/8).
 * Assumes input is already validated by isIP(); validates all octets for safety.
 */
function isIpv4Loopback(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) {
    return false;
  }

  const octets: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i] ?? '';
    const octet = parseInt(part, 10);
    if (Number.isNaN(octet) || octet < 0 || octet > 255) {
      return false;
    }
    octets.push(octet);
  }

  return octets[0] === 127;
}

/**
 * Check if an IPv6 address is the loopback address (::1).
 */
function isIpv6Loopback(addr: string): boolean {
  const normalised = normaliseIpv6(addr);
  return normalised === '0000:0000:0000:0000:0000:0000:0000:0001';
}

/**
 * Check if an IPv4-mapped IPv6 address (::ffff:a.b.c.d) is loopback.
 */
function isIpv4MappedIpv6Loopback(addr: string): boolean {
  const normalised = normaliseIpv6(addr);
  if (!normalised.startsWith('0000:0000:0000:0000:0000:ffff:')) {
    return false;
  }
  const hex1 = normalised.substring(
    '0000:0000:0000:0000:0000:ffff:'.length,
    '0000:0000:0000:0000:0000:ffff:'.length + 4,
  );
  const num1 = parseInt(hex1, 16);
  const firstOctet = (num1 >> 8) & 0xff;

  return firstOctet === 127;
}

/**
 * Whether `host` only accepts loopback connections. A loopback listener is only
 * reachable from local processes, so serving without authentication on it keeps
 * the single-user trust model; anything else is a network listener.
 * Recognises: localhost, 127.0.0.0/8, ::1 in any spelling, and ::ffff:127.x.x.x.
 * Handles IPv6 zone IDs (e.g., ::1%eth0) by stripping them before validation.
 */
export function isLoopbackHost(host: string): boolean {
  const lowered = host.trim().toLowerCase();
  // URL hostnames and Host headers spell IPv6 literals as [::1].
  const trimmed = lowered.startsWith('[') && lowered.endsWith(']') ? lowered.slice(1, -1) : lowered;

  if (trimmed === 'localhost') {
    return true;
  }

  const withoutZone = trimmed.split('%')[0] ?? '';
  const ipVersion = isIP(withoutZone);

  if (ipVersion === 4) {
    return isIpv4Loopback(withoutZone);
  }

  if (ipVersion === 6) {
    return isIpv6Loopback(withoutZone) || isIpv4MappedIpv6Loopback(withoutZone);
  }

  return false;
}

/** A private IPv4 address: RFC 1918, link-local, or the 100.64.0.0/10 range Tailscale uses. Loopback is not included. */
function isPrivateIpv4(addr: string): boolean {
  const octets = addr.split('.').map(part => Number.parseInt(part, 10));
  const [a, b] = octets;
  if (octets.length !== 4 || octets.some(octet => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  if (a === 10) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) {
    return true;
  }
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/**
 * Whether `host` is this computer or sits on a private network: loopback, a private IPv4 address, a `.local` or
 * `.ts.net` name, or a single-label name. An allowed origin may use plain http only for these; a public one needs https.
 */
export function isPrivateNetworkHost(host: string): boolean {
  if (isLoopbackHost(host)) {
    return true;
  }
  const lowered = host.trim().toLowerCase();
  const bare = lowered.startsWith('[') && lowered.endsWith(']') ? lowered.slice(1, -1) : lowered;
  const ipVersion = isIP(bare);
  if (ipVersion === 4) {
    return isPrivateIpv4(bare);
  }
  if (ipVersion === 6 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(bare)) {
    return false;
  }
  return !bare.includes('.') || bare.endsWith('.local') || bare.endsWith('.ts.net');
}

export interface NetworkAuthRequirement {
  authMode: TrueForgeAuthMode;
  /** True for `STANDALONE=true`, which never starts without login. */
  standalone: boolean;
  host: string;
  requireAuth: boolean;
}

/**
 * Refuse to start without login. A standalone server needs complete OIDC config whatever the
 * bind address (any local process could otherwise act as admin). Distributed mode keeps the
 * older rule: an unauthenticated non-loopback listener would expose settings endpoints (model
 * provider keys, MCP secrets), unless `REQUIRE_AUTH=false`. Throws with remediation steps;
 * main.ts calls this before anything is created.
 */
export function assertNetworkAuthRequirement(requirement: NetworkAuthRequirement): void {
  if (requirement.authMode !== TrueForgeAuthMode.Standalone) {
    return;
  }
  if (requirement.standalone) {
    throw new Error(
      'Refusing to start without login: standalone mode requires OIDC. ' +
        'Set OIDC_ISSUER_URL, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET (REQUIRE_AUTH=false no longer opts out). ' +
        'For local development run `pnpm dev:login` and add the lines it prints to packages/trueforge/.env; ' +
        'see docs/authentication/overview.mdx.',
    );
  }
  if (!requirement.requireAuth) {
    return;
  }
  if (isLoopbackHost(requirement.host)) {
    return;
  }
  throw new Error(
    `Refusing to listen on ${requirement.host} without authentication: without OIDC every request has the admin role, ` +
      'so settings endpoints (model provider keys, MCP secrets) would be reachable by anyone on the network. ' +
      'Configure OIDC (OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET), bind HOST=localhost for local-only use, ' +
      'or set REQUIRE_AUTH=false to explicitly accept this risk.',
  );
}

if (isTrueFoundryModeEnabled(configuration)) {
  // TrueFoundry authenticates each caller with their own gateway token, so browser SSO must be off.
  if (isOidcConfigured(configuration)) {
    throw new Error(
      'TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL (TrueFoundry mode) and OIDC (SSO) cannot both be enabled at once.',
    );
  }
  // TRUEFOUNDRY_API_KEY is required when TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL is set.
  if (configuration.TRUEFOUNDRY_API_KEY === undefined) {
    throw new Error('TRUEFOUNDRY_API_KEY is required when TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL is set.');
  }

  // Shared sandbox
  if (configuration.TRUEFOUNDRY_SANDBOX_ENABLED) {
    if (configuration.TRUEFOUNDRY_SANDBOX_PROVIDER === undefined) {
      throw new Error(
        'TRUEFOUNDRY_SANDBOX_ENABLED is true but TRUEFOUNDRY_SANDBOX_PROVIDER is not set. ' +
          'Set TRUEFOUNDRY_SANDBOX_PROVIDER to "daytona" or "truefoundry", or set TRUEFOUNDRY_SANDBOX_ENABLED=false.',
      );
    }
    if (configuration.TRUEFOUNDRY_SANDBOX_SETTINGS === undefined) {
      throw new Error(
        'TRUEFOUNDRY_SANDBOX_ENABLED is true but TRUEFOUNDRY_SANDBOX_SETTINGS is not set. ' +
          'Provide a JSON settings object, or set TRUEFOUNDRY_SANDBOX_ENABLED=false.',
      );
    }
    try {
      JSON.parse(configuration.TRUEFOUNDRY_SANDBOX_SETTINGS);
    } catch (error) {
      throw new Error('TRUEFOUNDRY_SANDBOX_SETTINGS must be valid JSON', { cause: error });
    }
    if (
      configuration.TRUEFOUNDRY_SANDBOX_PROVIDER === 'daytona' &&
      configuration.TRUEFOUNDRY_SANDBOX_API_KEY === undefined
    ) {
      throw new Error(
        'TRUEFOUNDRY_SANDBOX_PROVIDER=daytona requires TRUEFOUNDRY_SANDBOX_API_KEY, or set TRUEFOUNDRY_SANDBOX_ENABLED=false.',
      );
    }
    if (
      configuration.TRUEFOUNDRY_SANDBOX_PROVIDER === 'truefoundry' &&
      configuration.TRUEFOUNDRY_SANDBOX_SERVER_URL === undefined
    ) {
      throw new Error(
        'TRUEFOUNDRY_SANDBOX_PROVIDER=truefoundry requires TRUEFOUNDRY_SANDBOX_SERVER_URL, or set TRUEFOUNDRY_SANDBOX_ENABLED=false.',
      );
    }
  }
}

// run_code isolation driver: fail closed at startup. Selection happens
// once at server start; changing it requires a config change and restart.
// the image pin is the feature opt-in. A blank SANDBOX_IMAGE (the default
// for existing standalone installs) leaves run_code dormant — Docker is
// required only when run_code executes (plan §2.8), not at boot — while a
// configured image gets the full fail-closed validation.
const runCodeConfigured = configuration.SANDBOX_BACKEND === 'docker' && configuration.SANDBOX_IMAGE.trim() !== '';
if (configuration.SANDBOX_BACKEND === 'slots') {
  if (configuration.SANDBOX_SLOTS_DIR.trim() === '') {
    throw new Error('SANDBOX_SLOTS_DIR is required when SANDBOX_BACKEND=slots: it holds the slot control directories.');
  }
  if (configuration.SANDBOX_SLOTS > SANDBOX_MAX_SLOTS) {
    throw new Error(`SANDBOX_SLOTS must be at most ${String(SANDBOX_MAX_SLOTS)}.`);
  }
}
validateRunCodeStartupConfig({
  networkEgress: configuration.SANDBOX_NETWORK_EGRESS,
  isolationDriver: configuration.SANDBOX_ISOLATION_DRIVER,
  platform: process.platform,
  image: configuration.SANDBOX_IMAGE,
  imageConfigured: runCodeConfigured,
  imagePullTimeoutSeconds: configuration.SANDBOX_IMAGE_PULL_TIMEOUT_SECONDS,
  defaultTimeoutSeconds: configuration.SANDBOX_DEFAULT_TIMEOUT_SECONDS,
  maxTimeoutSeconds: configuration.SANDBOX_MAX_TIMEOUT_SECONDS,
  memoryMb: configuration.SANDBOX_MEMORY_MB,
  diskMb: configuration.SANDBOX_DISK_MB,
  outputCapKb: configuration.SANDBOX_STDOUT_STDERR_CAP_KB,
  runCodeToolCallTimeoutMs: getRunCodeToolCallTimeoutMs(),
  serverExecutionTimeoutSeconds: configuration.SERVER_EXECUTION_TIMEOUT_SECONDS,
});
// The cosign key is only needed once an image is configured; a dormant
// install must not fail boot for a key it will never use.
if (
  runCodeConfigured &&
  configuration.SANDBOX_ISOLATION_DRIVER === 'docker' &&
  configuration.SANDBOX_COSIGN_PUBLIC_KEY_PATH.trim() === ''
) {
  throw new Error(
    'SANDBOX_COSIGN_PUBLIC_KEY_PATH is required when SANDBOX_ISOLATION_DRIVER=docker and SANDBOX_IMAGE is set: ' +
      'the sandbox image signature is verified fail-closed. Point it at the release cosign public-key PEM.',
  );
}

if (!configuration.STANDALONE && configuration.TRUEFORGE_API_KEY.trim() === '') {
  throw new Error('TRUEFORGE_API_KEY must not be empty when STANDALONE=false.');
}

/** The settings the public URL helpers read. */
export type PublicUrlConfig = Pick<ServerConfiguration, 'STANDALONE' | 'PORT' | 'PUBLIC_BASE_URL'>;

/**
 * Effective public application URL. Empty `PUBLIC_BASE_URL` stays empty
 * (callers that need a callback origin throw).
 */
function effectivePublicBaseUrl(config: PublicUrlConfig): string {
  if (config.STANDALONE && config.PUBLIC_BASE_URL === '') {
    return `http://localhost:${String(config.PORT)}`;
  }
  return config.PUBLIC_BASE_URL;
}

/**
 * Public origin for OAuth callbacks.
 * `PUBLIC_BASE_URL` when set; standalone defaults to `http://localhost:$PORT`
 * (distributed throws if empty).
 */
export function getPublicBaseUrl(config: PublicUrlConfig = configuration): string {
  const publicBaseUrl = effectivePublicBaseUrl(config);
  if (publicBaseUrl === '') {
    throw new Error('PUBLIC_BASE_URL is required for OIDC callbacks but was empty');
  }
  return publicBaseUrl;
}

/** The origins the app may be opened at; empty unless `ALLOWED_ORIGINS` is set. */
export function getAllowedOrigins(config: Pick<ServerConfiguration, 'ALLOWED_ORIGINS'> = configuration): string[] {
  return config.ALLOWED_ORIGINS;
}

/** Suffix appended to every auth cookie name; empty unless `AUTH_COOKIE_SUFFIX` is set. */
export function getAuthCookieSuffix(config: ServerConfiguration = configuration): string {
  return config.AUTH_COOKIE_SUFFIX;
}

/**
 * run_code's own dispatch deadline in milliseconds. Derived from the
 * configured sandbox bounds — `image_pull_timeout_seconds` +
 * `max_timeout_seconds` + 60 s margin — so the long deadline tracks the
 * bounds it protects and stays scoped to sandbox/run_code instead of every
 * tool (which use `TOOL_CALL_TIMEOUT_MS`).
 */
export function getRunCodeToolCallTimeoutMs(config: ServerConfiguration = configuration): number {
  return (config.SANDBOX_IMAGE_PULL_TIMEOUT_SECONDS + config.SANDBOX_MAX_TIMEOUT_SECONDS) * 1000 + 60_000;
}

/** `/` or `/custom/proxy/path/` — trailing slash for asset URLs and the boot script. Empty → `/`. */
export function getPublicUiBasePath(config: PublicUrlConfig = configuration): string {
  const publicBaseUrl = effectivePublicBaseUrl(config);
  if (publicBaseUrl === '') {
    return '/';
  }
  const path = new URL(publicBaseUrl).pathname;
  return path === '/' ? '/' : `${path}/`;
}

export default configuration;
