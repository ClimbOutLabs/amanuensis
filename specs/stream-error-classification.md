# Spec: Stream Error Classification (v1)

## Problem

Stream error parts carrying a definite provider HTTP status were wrapped as `ModelStreamFault` unless they were `APICallError` instances. The AI SDK provider error shape (`data.code`) fell through the classification, so a provider-side 500 (for example from a request the provider rejects during structured-output processing) triggered the compact-and-retry recovery and surfaced a misleading "context too long" message for failures compaction cannot fix.

## Solution

Extract definite provider status codes from stream error parts across error shapes. Any stream error part carrying a definite provider status is a real answer from the provider, not a broken stream, and is surfaced as a plain `Error` (no compaction, no retry). Error parts with no definite status keep the existing `ModelStreamFault` recovery behavior.

## Design Decisions

**A definite provider status is a real answer, not a broken stream.** When the provider responds with an HTTP status code, the request reached the provider and was answered. Compacting context and retrying the identical request cannot change that answer. The correct behavior is to surface the error, not to recover from it.

**Covered shapes: `APICallError.statusCode` and provider error `data.code`.** The existing check only recognized `APICallError` instances. The AI SDK also surfaces provider failures as errors carrying `data.code` (a numeric HTTP status in a `data` payload). Both shapes indicate the same thing: the provider answered with a status. Both are now treated identically.

**Everything else stays `ModelStreamFault`.** Transport failures, malformed-response parse failures, and cut streams (the shape a provider closing the connection mid-response takes) have no status code. Those are the stream itself breaking, and the existing single compact-and-retry recovery still applies to them. This change narrows the `ModelStreamFault` classification; it does not remove or alter the recovery path.

**No status-code threshold.** Any numeric status on the error part (4xx or 5xx) is definite. The distinction that matters is "the provider answered" versus "the stream broke," not which status it was.

## Scope (v1)

- New `providerStatusCode()` helper in `VercelAILLM.ts` extracting a numeric status from `APICallError.statusCode` or a provider error's `data.code`.
- `mapStreamToChunks` uses `providerStatusCode()` instead of the `APICallError`-only check when classifying `error` stream parts.
- Regression test: a stream error part with the provider error `data.code` shape rejects as a plain `Error`, not `ModelStreamFault`.
- Existing tests for genuine stream faults (transport failure shape) and `APICallError` classification continue to pass unchanged.

## Architecture

### `providerStatusCode(raw: unknown): number | undefined`

Type-guarded extraction, no assertion escapes:

1. If `APICallError.isInstance(raw)` and `raw.statusCode` is a number, return it.
2. If `raw` is a non-null object with a `data` property, and `data` is a non-null object with a numeric `code` property, return it.
3. Otherwise return `undefined`.

### Classification in `mapStreamToChunks`

The `case 'error'` handler calls `providerStatusCode(raw)`:

- Status present: `throw new Error(message, { cause })`. Plain error. `AgentThread` does not compact, does not retry, and does not emit the context-too-long message.
- Status absent: `throw new ModelStreamFault(message, { cause })`. Unchanged existing behavior: `AgentThread` compacts once and retries, then surfaces the stream-fault message if the retry also fails.

### Error message

`describeStreamError` is unchanged. For `APICallError` with a status it produces `Request failed (<status>): <message>`; for other shapes it produces the underlying message. The plain `Error` thrown for a provider status carries this message with the original error as `cause`.

## Testing

- New test in `VercelAILLM.stream.test.ts`: an `error` part whose error carries `data: { code: 500, ... }` (the provider error shape) rejects as a plain `Error` and not as `ModelStreamFault`.
- Existing tests unchanged and passing: transport-failure shape still classifies as `ModelStreamFault`; `APICallError` with status still classifies as plain `Error`; the `AgentThread` retry tests (`modelStreamFault.test.ts`) still verify single compact-and-retry for genuine faults.
- Typecheck clean, lint clean on changed files.

## Out of Scope (explicitly not v1)

- The provider-side defect that produced the 500 (e.g. a structured-output processing failure in the model server). That is server-side and is not addressed here; this spec only corrects how the client classifies and surfaces the failure.
- Changing the `ModelStreamFault` recovery behavior itself (single compact-and-retry, then the stream-fault message).
- Changing the user-facing stream-fault message text.
- Retrying provider-status errors with backoff or failover. A definite provider answer is not retried in v1.

## Later phases

- If specific provider statuses prove transient in practice (e.g. 429 rate limits from a specific provider), a later spec may define per-status retry policy. That policy must distinguish "the provider said no" from "the provider is temporarily busy" and must not reintroduce compaction for non-context failures.
