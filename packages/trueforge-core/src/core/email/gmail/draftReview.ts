/**
 * What the user was shown before a send. The send card is built from the draft as Gmail holds it, and the
 * send goes through only if the draft still hashes to what was shown, so an edit made after review, by
 * anyone, makes the send refuse instead of mailing different text.
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '../../permissions/approvalTokens';

/** A reviewed draft is good for this long; after it the send must be reviewed again. */
const REVIEW_TTL_MS = 30 * 60 * 1000;

export interface ReviewableDraft {
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  body: string;
  threadId: string;
}

/** Hash of everything a send delivers. */
export function hashDraft(draft: ReviewableDraft): string {
  return createHash('sha256').update(stableStringify(draft)).digest('hex');
}

interface ReviewKey {
  tenant_id: string;
  created_by: string;
  draft_id: string;
}

function keyOf(key: ReviewKey): string {
  return JSON.stringify([key.tenant_id, key.created_by, key.draft_id]);
}

/**
 * In-process memory of the reviewed hash per user and draft. It is process-local on purpose: after a
 * restart nothing was reviewed, so a pending send fails closed and is asked again.
 */
export class DraftReviewLedger {
  readonly #reviews = new Map<string, { hash: string; expires_at: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The first review of a draft stands until it is used, changed through Aman, or expires. */
  record(input: ReviewKey & { hash: string }): void {
    const existing = this.#reviews.get(keyOf(input));
    if (existing === undefined || existing.expires_at <= this.#now()) {
      this.#reviews.set(keyOf(input), { hash: input.hash, expires_at: this.#now() + REVIEW_TTL_MS });
    }
  }

  /** Returns and removes the reviewed hash, so one review covers one send. */
  take(key: ReviewKey): string | undefined {
    const review = this.#reviews.get(keyOf(key));
    this.#reviews.delete(keyOf(key));
    return review === undefined || review.expires_at <= this.#now() ? undefined : review.hash;
  }

  /** An edit made through Aman voids any earlier review of that draft. */
  forget(key: ReviewKey): void {
    this.#reviews.delete(keyOf(key));
  }
}
