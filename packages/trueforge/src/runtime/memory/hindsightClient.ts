/**
 * Typed client for the Hindsight memory-provider REST API (recall / retain / operations).
 *
 * Every method returns a discriminated `{ ok }` result and never throws: a memory-provider
 * failure must never fail, block, or delay a turn beyond its own timeout (design invariant 1).
 * There is no internal retry: the capability's sweep is the retry loop for retain operations,
 * and a failed recall simply degrades to no memory for that turn.
 */
import type { RemoteMcpHeaders } from '@truefoundry/trueforge-core/core';
import configuration from '../../config';
import type { MemoryProviderFailureCode } from '../../schemas/memoryProvider';
import { readBodyWithinCap } from './boundedBodyReader';

/** Upper bound on the upstream error text carried into a reason line, a log field, or the UI. */
const ERROR_DETAIL_MAX_CHARS = 200;

export interface RecallItem {
  id: string;
  text: string;
  type: string;
  entities?: string[];
  occurred_start?: string;
  occurred_end?: string;
  context?: string;
  /**
   * Provenance and bookkeeping the provider stored with the memory (e.g. `origin`, `turn_id`),
   * carried back so the recall screen can read a recalled item's origin. Only string-valued
   * entries survive sanitization; a missing or malformed map reads as no metadata.
   */
  metadata?: Record<string, string>;
  /**
   * Provider relevance score for this item, when the provider includes one. Not bounded to
   * [0, 1] by this client (the caller's threshold decides what counts as relevant); absent
   * when the provider did not send a numeric score, in which case ranking falls back to the
   * response's own array order (see applyRelevanceGate in memoryCapability.ts).
   */
  score?: number;
}

export interface EntityObservation {
  text: string;
  mentioned_at?: string;
}

/** One recalled entity, keyed by its name in the response's `entities` map. */
export interface EntitySummary {
  name: string;
  canonical_name: string;
  observations: EntityObservation[];
  /** As {@link RecallItem.score}, when the provider summarizes entities with a relevance score. */
  score?: number;
}

/**
 * One failed call. `code` is the machine-readable classification callers switch on (the
 * save-time provider check, the recall outcome event) instead of matching `reason` text;
 * `reason` is the human-readable line for logs and the UI; `httpStatus` and `detail` carry the
 * upstream status and its own error message whenever the provider answered, so a rejected
 * credential surfaces as the provider stated it rather than as a bare status. `invalid_url` is
 * the one code this client never produces: a URL is parsed before a client is built from it.
 */
export interface MemoryFailure {
  ok: false;
  code: MemoryProviderFailureCode;
  reason: string;
  httpStatus?: number;
  detail?: string;
}

export type RecallOutcome = { ok: true; results: RecallItem[]; entities: EntitySummary[] } | MemoryFailure;

function sanitizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A finite numeric score, or undefined for anything else (missing, NaN, a string, etc.). */
function sanitizeOptionalScore(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Drops a malformed result entry rather than letting it survive into formatting, where an
 * unexpected shape could throw later and escape the recall degrade path (design invariant 1).
 */
function sanitizeRecallItem(value: unknown): RecallItem | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (typeof item['text'] !== 'string') {
    return null;
  }
  const sanitized: RecallItem = {
    id: typeof item['id'] === 'string' ? item['id'] : '',
    text: item['text'],
    type: typeof item['type'] === 'string' ? item['type'] : 'unknown',
  };
  const occurredStart = sanitizeOptionalString(item['occurred_start']);
  if (occurredStart !== undefined) {
    sanitized.occurred_start = occurredStart;
  }
  const occurredEnd = sanitizeOptionalString(item['occurred_end']);
  if (occurredEnd !== undefined) {
    sanitized.occurred_end = occurredEnd;
  }
  const context = sanitizeOptionalString(item['context']);
  if (context !== undefined) {
    sanitized.context = context;
  }
  const entities = item['entities'];
  if (Array.isArray(entities) && entities.every(entry => typeof entry === 'string')) {
    sanitized.entities = entities;
  }
  const metadata = sanitizeStringMap(item['metadata']);
  if (metadata !== undefined) {
    sanitized.metadata = metadata;
  }
  const score = sanitizeOptionalScore(item['score']);
  if (score !== undefined) {
    sanitized.score = score;
  }
  return sanitized;
}

/** Keeps only string-valued entries of a provider-supplied map; returns undefined when there are none. */
function sanitizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeRecallItems(value: unknown): RecallItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: RecallItem[] = [];
  for (const entry of value) {
    const sanitized = sanitizeRecallItem(entry);
    if (sanitized) {
      items.push(sanitized);
    }
  }
  return items;
}

function sanitizeObservation(value: unknown): EntityObservation | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const observation = value as Record<string, unknown>;
  if (typeof observation['text'] !== 'string') {
    return null;
  }
  const sanitized: EntityObservation = { text: observation['text'] };
  const mentionedAt = sanitizeOptionalString(observation['mentioned_at']);
  if (mentionedAt !== undefined) {
    sanitized.mentioned_at = mentionedAt;
  }
  return sanitized;
}

function sanitizeObservations(value: unknown): EntityObservation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const observations: EntityObservation[] = [];
  for (const entry of value) {
    const sanitized = sanitizeObservation(entry);
    if (sanitized) {
      observations.push(sanitized);
    }
  }
  return observations;
}

export interface RetainItem {
  content: string;
  timestamp: string;
  context?: string;
  document_id: string;
  metadata?: Record<string, string>;
}

export interface RetainOutcome {
  ok: boolean;
  reason?: string;
}

export type GetOperationOutcome = { ok: true; status: string } | MemoryFailure;

/**
 * Canonical reading of provider operation statuses. `getOperation` returns the
 * raw provider string; these are the only interpretations the host relies on.
 */
export function isOperationCompletedStatus(status: string): boolean {
  return status === 'completed' || status === 'success' || status === 'succeeded';
}

export function isOperationFailedStatus(status: string): boolean {
  return status === 'failed' || status === 'error';
}

/** The bank's operator-set profile; every field optional on the wire, so every field optional here. */
export interface BankProfile {
  name: string | undefined;
  mission: string | undefined;
  background: string | undefined;
}

export type GetProfileOutcome = { ok: true; profile: BankProfile } | MemoryFailure;

/** One curated mental model as the bank lists it; `isStale` is the provider's own freshness flag. */
export interface MentalModel {
  id: string;
  name: string;
  content: string;
  tags: string[];
  /** The provider's freshness verdict; undefined when the listing carried none, which is not the same as current. */
  isStale: boolean | undefined;
}

export type ListMentalModelsOutcome = { ok: true; models: MentalModel[] } | MemoryFailure;

/** The provider's reflect effort level; `low` is a single pass, the others loop further. */
export type ReflectBudget = 'low' | 'mid' | 'high';

/** `basedOn` is how many memories the provider says the reflection drew on, for the event only. */
export type ReflectOutcome = { ok: true; text: string; basedOn: number } | MemoryFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A response body as a JSON object, or null when it is not valid JSON or not an object. */
function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Drops a malformed mental model rather than letting it reach formatting (design invariant 1). */
function sanitizeMentalModel(value: unknown): MentalModel | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const id = sanitizeOptionalString(record['id']);
  const name = sanitizeOptionalString(record['name']);
  const content = sanitizeOptionalString(record['content']);
  if (id === undefined || name === undefined || content === undefined) {
    return null;
  }
  const rawTags = record['tags'];
  const tags = Array.isArray(rawTags) ? rawTags.filter((tag): tag is string => typeof tag === 'string') : [];
  const rawStale = record['is_stale'];
  return { id, name, content, tags, isStale: typeof rawStale === 'boolean' ? rawStale : undefined };
}

export interface RetryOperationOutcome {
  ok: boolean;
}

type ResolvedHeaders = { ok: true; headers: Record<string, string> } | MemoryFailure;

async function resolveHeaders(headers: RemoteMcpHeaders): Promise<ResolvedHeaders> {
  if (typeof headers !== 'function') {
    return { ok: true, headers };
  }
  const result = await headers();
  if ('authRequired' in result) {
    return { ok: false, code: 'auth_required', reason: 'connector requires authorization' };
  }
  return { ok: true, headers: result.headers };
}

/** Never rejects: a resolver that throws or rejects degrades to an `ok:false` outcome instead. */
async function resolveHeadersSafely(headers: RemoteMcpHeaders): Promise<ResolvedHeaders> {
  try {
    return await resolveHeaders(headers);
  } catch (error) {
    return {
      ok: false,
      code: 'header_resolution_failed',
      reason: `header resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Rejects with a TimeoutError-named Error once `signal` fires, and never resolves otherwise.
 * Used to race header resolution against the same timeout that bounds the fetch itself, so a
 * resolver that stalls (or never settles) cannot hold a turn open past `timeoutMs`.
 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  const promise = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      const error = new Error('The operation was aborted');
      error.name = 'TimeoutError';
      reject(error);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // Prevent an unhandled-rejection warning when this loses the race: Promise.race does not
  // cancel the loser, and the timeout signal still fires later for a resolver that won first.
  promise.catch(() => undefined);
  return promise;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function timeoutFailure(timeoutMs: number): MemoryFailure {
  return { ok: false, code: 'timeout', reason: `request timed out after ${String(timeoutMs)}ms` };
}

/**
 * The timeout bounding one request. It is created before header resolution and stays armed while
 * the response body is read, so both steps share the single budget the caller asked for.
 */
interface RequestTimeout {
  signal: AbortSignal;
  timeoutMs: number;
}

/** A response whose headers arrived, carried with the timeout that still bounds its body. */
interface SentRequest {
  ok: true;
  response: Response;
  timeout: RequestTimeout;
}

export interface HindsightClientConfig {
  apiBase: string;
  bank: string;
  headers: RemoteMcpHeaders;
  fetchImpl?: typeof fetch;
  /** Overrides `configuration.MEMORY_MAX_RESPONSE_BYTES`; primarily for tests. */
  maxResponseBytes?: number;
}

/** Small typed client over one Hindsight bank's recall / retain / operations endpoints. */
export class HindsightClient {
  private readonly apiBase: string;
  private readonly bank: string;
  private readonly headers: RemoteMcpHeaders;
  private readonly fetchImpl: typeof fetch;
  private readonly maxResponseBytes: number;

  constructor(input: HindsightClientConfig) {
    this.apiBase = input.apiBase.replace(/\/+$/, '');
    this.bank = input.bank;
    this.headers = input.headers;
    this.fetchImpl = input.fetchImpl ?? fetch;
    this.maxResponseBytes = input.maxResponseBytes ?? configuration.MEMORY_MAX_RESPONSE_BYTES;
  }

  async recall(params: {
    query: string;
    maxTokens: number;
    queryTimestamp: string;
    entityTokens: number;
    timeoutMs: number;
  }): Promise<RecallOutcome> {
    const sent = await this.send({
      path: '/memories/recall',
      method: 'POST',
      timeoutMs: params.timeoutMs,
      body: {
        query: params.query,
        max_tokens: params.maxTokens,
        query_timestamp: params.queryTimestamp,
        types: ['world', 'experience', 'observation'],
        prefer_observations: true,
        include: { entities: { max_tokens: params.entityTokens } },
      },
    });
    if (!sent.ok) {
      return sent;
    }
    if (!sent.response.ok) {
      return this.httpFailure({ sent, operation: 'recall' });
    }
    const body = await this.readBody(sent);
    if (!body.ok) {
      return body;
    }
    try {
      const parsed = JSON.parse(body.text) as {
        results?: unknown;
        entities?: Record<string, unknown>;
      };
      const results = sanitizeRecallItems(parsed.results);
      const entities: EntitySummary[] = [];
      if (parsed.entities && typeof parsed.entities === 'object') {
        for (const [name, value] of Object.entries(parsed.entities)) {
          if (!value || typeof value !== 'object') {
            continue;
          }
          const entry = value as { canonical_name?: unknown; observations?: unknown; score?: unknown };
          const canonicalName = typeof entry.canonical_name === 'string' ? entry.canonical_name : name;
          const observations = sanitizeObservations(entry.observations);
          const score = sanitizeOptionalScore(entry.score);
          entities.push({
            name,
            canonical_name: canonicalName,
            observations,
            ...(score !== undefined ? { score } : {}),
          });
        }
      }
      return { ok: true, results, entities };
    } catch {
      return {
        ok: false,
        code: 'invalid_response',
        reason: 'recall response could not be parsed',
      };
    }
  }

  async retain(params: { items: RetainItem[]; operationId: string; timeoutMs: number }): Promise<RetainOutcome> {
    const sent = await this.send({
      path: '/memories',
      method: 'POST',
      timeoutMs: params.timeoutMs,
      body: { items: params.items, async: true, operation_id: params.operationId },
    });
    if (!sent.ok) {
      return { ok: false, reason: sent.reason };
    }
    // 409 means the operation id already belongs to a submitted operation: idempotent success.
    if (sent.response.status === 409) {
      return { ok: true };
    }
    if (!sent.response.ok) {
      const failure = await this.httpFailure({ sent, operation: 'retain' });
      return { ok: false, reason: failure.reason };
    }
    return { ok: true };
  }

  async getOperation(id: string, timeoutMs: number): Promise<GetOperationOutcome> {
    const sent = await this.send({ path: `/operations/${id}`, method: 'GET', timeoutMs });
    if (!sent.ok) {
      return sent;
    }
    // A vanished operation reads the same as "nothing to wait for" so a sweep drops it.
    if (sent.response.status === 404) {
      return { ok: true, status: 'unknown' };
    }
    if (!sent.response.ok) {
      return this.httpFailure({ sent, operation: 'operation status' });
    }
    const body = await this.readBody(sent);
    if (!body.ok) {
      return body;
    }
    try {
      const parsed = JSON.parse(body.text) as { status?: unknown };
      return { ok: true, status: typeof parsed.status === 'string' ? parsed.status : 'unknown' };
    } catch {
      return {
        ok: false,
        code: 'invalid_response',
        reason: 'operation response could not be parsed',
      };
    }
  }

  async retryOperation(id: string, timeoutMs: number): Promise<RetryOperationOutcome> {
    const sent = await this.send({ path: `/operations/${id}/retry`, method: 'POST', timeoutMs });
    if (!sent.ok) {
      return { ok: false };
    }
    return { ok: sent.response.ok };
  }

  async getProfile(timeoutMs: number): Promise<GetProfileOutcome> {
    const sent = await this.send({ path: '/profile', method: 'GET', timeoutMs });
    if (!sent.ok) {
      return sent;
    }
    if (!sent.response.ok) {
      return this.httpFailure({ sent, operation: 'profile' });
    }
    const body = await this.readBody(sent);
    if (!body.ok) {
      return body;
    }
    const parsed = parseJsonRecord(body.text);
    if (parsed === null) {
      return { ok: false, code: 'invalid_response', reason: 'profile response could not be parsed' };
    }
    return {
      ok: true,
      profile: {
        name: sanitizeOptionalString(parsed['name']),
        mission: sanitizeOptionalString(parsed['mission']),
        background: sanitizeOptionalString(parsed['background']),
      },
    };
  }

  async listMentalModels(params: { limit: number; timeoutMs: number }): Promise<ListMentalModelsOutcome> {
    const sent = await this.send({
      path: `/mental-models?limit=${String(params.limit)}`,
      method: 'GET',
      timeoutMs: params.timeoutMs,
    });
    if (!sent.ok) {
      return sent;
    }
    if (!sent.response.ok) {
      return this.httpFailure({ sent, operation: 'mental models' });
    }
    const body = await this.readBody(sent);
    if (!body.ok) {
      return body;
    }
    const parsed = parseJsonRecord(body.text);
    if (parsed === null) {
      return { ok: false, code: 'invalid_response', reason: 'mental models response could not be parsed' };
    }
    const items = parsed['items'];
    const models = Array.isArray(items)
      ? items.map(sanitizeMentalModel).filter((model): model is MentalModel => model !== null)
      : [];
    return { ok: true, models };
  }

  async reflect(params: {
    query: string;
    budget: ReflectBudget;
    maxTokens: number;
    timeoutMs: number;
  }): Promise<ReflectOutcome> {
    const sent = await this.send({
      path: '/reflect',
      method: 'POST',
      timeoutMs: params.timeoutMs,
      // `include.facts` asks the provider to report which memories the answer drew on; the count
      // goes on the event, the facts themselves are not injected (recall already carries facts).
      body: { query: params.query, budget: params.budget, max_tokens: params.maxTokens, include: { facts: {} } },
    });
    if (!sent.ok) {
      return sent;
    }
    if (!sent.response.ok) {
      return this.httpFailure({ sent, operation: 'reflect' });
    }
    const body = await this.readBody(sent);
    if (!body.ok) {
      return body;
    }
    const parsed = parseJsonRecord(body.text);
    if (parsed === null) {
      return { ok: false, code: 'invalid_response', reason: 'reflect response could not be parsed' };
    }
    const text = parsed['text'];
    // `based_on` is an object of source arrays (memories, mental_models, directives); the event
    // reports the memories the answer drew on. Absent or malformed provenance counts as zero.
    const basedOn = parsed['based_on'];
    const memories = isRecord(basedOn) ? basedOn['memories'] : undefined;
    return {
      ok: true,
      text: typeof text === 'string' ? text : '',
      basedOn: Array.isArray(memories) ? memories.length : 0,
    };
  }

  private bankUrl(path: string): string {
    return `${this.apiBase}/v1/default/banks/${this.bank}${path}`;
  }

  /**
   * Resolves headers fresh (mirrors RemoteMCP's resolver contract), then fetches with a timeout.
   * The timeout signal is created before header resolution starts and bounds every step: header
   * resolution (which may run DCR or a secret-reference resolver) is raced against the same
   * signal, so a resolver that throws, rejects, or simply stalls cannot hold the turn open past
   * `timeoutMs` or escape the catch below. The signal is returned with the response because it
   * still bounds the body read, which happens after this method has handed the response back.
   */
  private async send(input: {
    path: string;
    method: 'GET' | 'POST';
    timeoutMs: number;
    body?: unknown;
  }): Promise<SentRequest | MemoryFailure> {
    const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
    const timeout: RequestTimeout = { signal: timeoutSignal, timeoutMs: input.timeoutMs };
    try {
      const resolved = await Promise.race([resolveHeadersSafely(this.headers), rejectOnAbort(timeoutSignal)]);
      if (!resolved.ok) {
        return resolved;
      }
      const response = await this.fetchImpl(this.bankUrl(input.path), {
        method: input.method,
        headers: {
          ...resolved.headers,
          ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        signal: timeoutSignal,
      });
      return { ok: true, response, timeout };
    } catch (error) {
      if (isTimeoutError(error)) {
        return timeoutFailure(input.timeoutMs);
      }
      return {
        ok: false,
        code: 'request_failed',
        reason: `request failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Failure for a non-2xx answer, carrying the upstream status and the provider's own message.
   * The body is read through the same byte cap as a success body, so an HTML error page or a
   * runaway payload cannot flood a log line or a settings error toast.
   */
  private async httpFailure(input: { sent: SentRequest; operation: string }): Promise<MemoryFailure> {
    const status = input.sent.response.status;
    const detail = await this.readErrorDetail(input.sent);
    const suffix = detail === undefined ? '' : `: ${detail}`;
    return {
      ok: false,
      code: 'http_error',
      httpStatus: status,
      ...(detail === undefined ? {} : { detail }),
      reason: `${input.operation} returned HTTP ${String(status)}${suffix}`,
    };
  }

  /**
   * The provider's stated reason for refusing, from a JSON `detail` field (Hindsight's shape)
   * or the raw body when it is not JSON. Whitespace is collapsed and the text truncated so a
   * multi-line page becomes one readable clause.
   */
  private async readErrorDetail(sent: SentRequest): Promise<string | undefined> {
    const body = await this.readBody(sent);
    if (!body.ok) {
      return undefined;
    }
    let text = body.text;
    try {
      const parsed: unknown = JSON.parse(body.text);
      if (parsed !== null && typeof parsed === 'object') {
        const detail = (parsed as { detail?: unknown }).detail;
        if (typeof detail === 'string') {
          text = detail;
        }
      }
    } catch {
      // Not JSON: fall through to the raw body text below.
    }
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (collapsed.length === 0) {
      return undefined;
    }
    return collapsed.length > ERROR_DETAIL_MAX_CHARS ? `${collapsed.slice(0, ERROR_DETAIL_MAX_CHARS)}…` : collapsed;
  }

  private oversizeBodyResult(): MemoryFailure {
    return {
      ok: false,
      code: 'invalid_response',
      reason: `response exceeds the ${String(this.maxResponseBytes)} byte limit`,
    };
  }

  /**
   * Why a body read did not finish. The send timeout is still armed once headers have arrived, so
   * an abort here is a provider that stalled mid-stream, not a payload the client could not parse:
   * reporting `invalid_response` would blame the shape of an answer that never fully arrived, and
   * would misclassify the recall event's outcome as an error instead of a timeout.
   */
  private bodyReadFailure(input: { error: unknown; timeout: RequestTimeout }): MemoryFailure {
    if (isTimeoutError(input.error) || input.timeout.signal.aborted) {
      return timeoutFailure(input.timeout.timeoutMs);
    }
    return {
      ok: false,
      code: 'invalid_response',
      reason: `response could not be read: ${input.error instanceof Error ? input.error.message : String(input.error)}`,
    };
  }

  /**
   * Caps the body read via the shared {@link readBodyWithinCap} reader (one owner with
   * {@link ScreenClient}), mapping its neutral result back to this client's {@link MemoryFailure}
   * shapes. An over-cap body becomes {@link oversizeBodyResult}; any decode or stream failure keeps
   * its underlying cause so {@link bodyReadFailure} can still classify a timeout abort.
   */
  private async readBody(sent: SentRequest): Promise<{ ok: true; text: string } | MemoryFailure> {
    const read = await readBodyWithinCap(sent.response, this.maxResponseBytes);
    if (read.ok) {
      return { ok: true, text: read.text };
    }
    if (read.kind === 'oversize') {
      return this.oversizeBodyResult();
    }
    return this.bodyReadFailure({ error: read.cause, timeout: sent.timeout });
  }
}
