/**
 * The record of a stream silence deadline firing: which deadline, and what the stream last did
 * before it. The firing site (VercelAILLM's deadline guard) records it against the error it
 * raises; whoever ends the turn reads it back off whichever error they end up holding, so the
 * turn's one log line can say which deadline fired, after which progress, and how long ago.
 */

export interface StreamDeadlineDetails {
  /** The deadline that fired: waiting for the first progress, or for the next progress after some arrived. */
  deadline: 'first_chunk' | 'chunk';
  /** The bound that expired, in milliseconds. */
  timeoutMs: number;
  /** The field that carried the last progress (see chunkSubstanceField in VercelAILLM); null when none arrived. */
  lastProgressField: string | null;
  /** Milliseconds between the last progress and the deadline firing; null when none arrived. */
  msSinceLastProgress: number | null;
}

const detailsByError = new WeakMap<object, StreamDeadlineDetails>();

/** Records the firing against the error that carries it to the caller. */
export function recordStreamDeadlineDetails(error: object, details: StreamDeadlineDetails): void {
  detailsByError.set(error, details);
}

/**
 * The deadline details recorded for an error, following its cause chain: wrappers between the
 * stream and the caller (the SDK's own abort surfacing, the harness's error mapping) preserve
 * the chain, so the firing stays answerable from the final error.
 */
export function streamDeadlineDetailsOf(error: unknown): StreamDeadlineDetails | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
    const details = detailsByError.get(current);
    if (details !== undefined) {
      return details;
    }
    current = Reflect.get(current, 'cause');
  }
  return undefined;
}
