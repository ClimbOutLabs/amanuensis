/**
 * Typed client for the `aman-content-screen` prompt-injection classifier used by the memory
 * recall screen (`POST {url}/classify`, bearer auth). It is a separate service from the memory
 * provider (Hindsight): the provider stores and recalls memories, this classifier judges whether
 * a recalled memory's text is a prompt-injection attempt before it reaches the model.
 *
 * Same posture as {@link HindsightClient}: every call returns a discriminated result and never
 * throws. A screen that is disabled, misconfigured, unreachable, non-2xx, slow, oversized, or
 * unparseable degrades to a well-defined `ok: false` "unknown" result; the caller (the recall
 * capability) owns the fail posture, so no screen failure can fail, block, or delay a turn beyond
 * its own timeout.
 *
 * Two properties this client must not weaken, both prompt-injection escape hatches:
 * - The text classified is the exact text sent for injection. The full item is forwarded, never a
 *   truncated prefix, so a benign prefix cannot hide an injection the model would still receive.
 *   Memory items are short facts, and the classifier sidecar windows long inputs itself, taking
 *   the worst (max malicious score) window, so it is the right place to bound length, not here.
 * - A verdict is trusted only when it parses into a valid score/label/flagged shape. A missing or
 *   malformed score is "unknown", never benign, so a garbage body cannot slip past the caller's
 *   unknown-result fencing.
 */
import type {
  ToolOutputScreenClassification,
  ToolOutputScreenFailureReasonCode,
} from '@truefoundry/trueforge-core/core';
import { z } from 'zod';
import { readBodyWithinCap as readBoundedBody } from './boundedBodyReader';

/** Upper bound on the classifier's own error text carried into a reason line. */
const ERROR_DETAIL_MAX_CHARS = 200;

/**
 * Max bytes read from a `/classify` response body. The verdict is a handful of fields, so this
 * only guards against a faulty or compromised sidecar ballooning memory (amplified by parallel
 * per-item screening); a body past the cap is treated as "unknown", never benign.
 */
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * One classification outcome.
 * - `ok: true`: the classifier returned a usable verdict; `flagged` is true when it judged the
 *   text a prompt-injection attempt (its own `flagged`, its `label`, or its `score` at/above the
 *   threshold), and `score` is the classifier's confidence.
 * - `ok: false`: no usable verdict (disabled, misconfigured, unreachable, non-2xx, oversized,
 *   unparseable, malformed, or timed out). `score` is 0 and `reason` says why. The caller treats
 *   this as "unknown".
 */
export type ScreenClassifyResult = ToolOutputScreenClassification & {
  reason: string | null;
};

export interface ScreenClientConfig {
  /** Base URL of the classifier; `/classify` is appended. Trailing slashes are trimmed. */
  url: string;
  /** Bearer token for the classifier. Empty sends no Authorization header. */
  authToken: string;
  /** Score at or above which a verdict counts as malicious; forwarded as the request `threshold`. */
  threshold: number;
  fetchImpl?: typeof fetch;
  /** Overrides {@link DEFAULT_MAX_RESPONSE_BYTES}; primarily for tests. */
  maxResponseBytes?: number;
}

/**
 * The `/classify` verdict wire shape, validated (parsed) rather than trusted. `score` must be a
 * finite number in the unit interval; a body counts as a verdict only when it carries at least one
 * of an explicit `flagged`, a known `label`, or a `score`. Anything else fails `safeParse` and the
 * caller reads the result as "unknown", so a missing or garbage score can never default to benign
 * (finding: malformed verdicts must not become benign).
 */
const ScreenVerdictSchema = z
  .object({
    label: z.string().optional(),
    score: z.number().gte(0).lte(1).optional(),
    flagged: z.boolean().optional(),
  })
  .refine(
    verdict =>
      typeof verdict.flagged === 'boolean' ||
      verdict.label === 'malicious' ||
      verdict.label === 'benign' ||
      typeof verdict.score === 'number',
    { message: 'no usable score, label, or flagged field' },
  );

type CappedBodyRead =
  { ok: true; text: string } | { ok: false; reasonCode: ToolOutputScreenFailureReasonCode; reason: string };

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

/** The well-defined "unknown" result the caller reads as a screen that gave no verdict. */
function unknownResult(reasonCode: ToolOutputScreenFailureReasonCode, reason: string): ScreenClassifyResult {
  return { ok: false, flagged: false, score: 0, reasonCode, reason };
}

/** Small typed client over one classifier's `/classify` endpoint. */
export class ScreenClient {
  private readonly url: string;
  private readonly authToken: string;
  private readonly threshold: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxResponseBytes: number;

  constructor(input: ScreenClientConfig) {
    this.url = input.url.replace(/\/+$/, '');
    this.authToken = input.authToken;
    this.threshold = input.threshold;
    this.fetchImpl = input.fetchImpl ?? fetch;
    this.maxResponseBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  /**
   * Classifies one item's text. Never throws and never resolves later than `timeoutMs`: a request
   * that stalls is aborted and returns an "unknown" result. An empty configured URL short-circuits
   * to "unknown" without a network call, so an operator can enable screening before the sidecar is
   * reachable without every turn paying a connection failure.
   *
   * The full item text is sent, never a client-side prefix: truncating here would let the
   * classifier judge only a benign head while the whole item (injection included) is what reaches
   * the model. The sidecar windows long inputs and reports the worst window, so length is bounded
   * there, not by dropping the tail the model would still see.
   */
  async classify(params: { text: string; timeoutMs: number }): Promise<ScreenClassifyResult> {
    if (this.url === '') {
      return unknownResult('screen_not_configured', 'screen url not configured');
    }
    const body = JSON.stringify({ text: params.text, threshold: this.threshold });
    try {
      const response = await this.fetchImpl(`${this.url}/classify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.authToken === '' ? {} : { authorization: `Bearer ${this.authToken}` }),
        },
        body,
        signal: AbortSignal.timeout(params.timeoutMs),
      });
      if (!response.ok) {
        return unknownResult('screen_http_error', `classify returned HTTP ${String(response.status)}`);
      }
      return await this.parseVerdict(response);
    } catch (error) {
      if (isTimeoutError(error)) {
        return unknownResult('screen_timeout', `classify timed out after ${String(params.timeoutMs)}ms`);
      }
      return unknownResult(
        'screen_request_failed',
        `classify request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Reads the body within the byte cap, then validates it against {@link ScreenVerdictSchema}. A
   * body that is oversized, unreadable, not JSON, or not a valid verdict degrades to "unknown"
   * rather than a benign default.
   */
  private async parseVerdict(response: Response): Promise<ScreenClassifyResult> {
    const body = await this.readBodyWithinCap(response);
    if (!body.ok) {
      return unknownResult(body.reasonCode, body.reason);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return unknownResult(
        'screen_malformed_response',
        `classify response could not be parsed: ${body.text.slice(0, ERROR_DETAIL_MAX_CHARS)}`,
      );
    }
    const verdict = ScreenVerdictSchema.safeParse(parsed);
    if (!verdict.success) {
      return unknownResult('screen_malformed_response', 'classify response was not a valid verdict shape');
    }
    const { label, flagged: reportedFlagged, score: reportedScore } = verdict.data;
    const score = reportedScore ?? 0;
    // Prefer the service's explicit `flagged`; fall back to its `label`, then to the score against
    // the configured threshold, so a partial (but valid) response still yields a defined verdict.
    let flagged: boolean;
    if (typeof reportedFlagged === 'boolean') {
      flagged = reportedFlagged;
    } else if (label === 'malicious') {
      flagged = true;
    } else if (label === 'benign') {
      flagged = false;
    } else {
      flagged = score >= this.threshold;
    }
    return { ok: true, flagged, score, reasonCode: null, reason: null };
  }

  /**
   * Caps the body read via the shared {@link readBoundedBody} reader (one owner with
   * {@link HindsightClient}), mapping its neutral result to this client's reason strings. Never
   * throws: an over-cap body or any decode/stream failure resolves to an `ok: false` reason the
   * caller maps to "unknown".
   */
  private async readBodyWithinCap(response: Response): Promise<CappedBodyRead> {
    const read = await readBoundedBody(response, this.maxResponseBytes);
    if (read.ok) {
      return { ok: true, text: read.text };
    }
    if (read.kind === 'oversize') {
      return this.oversizeResult();
    }
    return {
      ok: false,
      reasonCode: 'screen_response_unreadable',
      reason: `classify body unreadable: ${read.cause instanceof Error ? read.cause.message : String(read.cause)}`,
    };
  }

  private oversizeResult(): CappedBodyRead {
    return {
      ok: false,
      reasonCode: 'screen_response_too_large',
      reason: `classify response exceeds the ${String(this.maxResponseBytes)} byte limit`,
    };
  }
}
