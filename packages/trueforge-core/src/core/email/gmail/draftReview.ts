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
  /** The `In-Reply-To` and `References` headers, so a change in threading counts as a change. */
  inReplyTo: string;
  references: string;
  /** The display name the message is sent under, which recipients see; empty when there is none. */
  fromName: string;
}

/** Hash of everything a send delivers. */
export function hashDraft(draft: ReviewableDraft): string {
  return createHash('sha256').update(stableStringify(draft)).digest('hex');
}

/** Characters of the hash a person is shown; enough to compare by eye, not a security boundary. */
const CHECK_CODE_LENGTH = 6;

/**
 * The short code printed on a send card and again on its receipt. It is cut from the same hash the send gate
 * binds, so a receipt carrying the card's code shows the message that was approved was the one sent.
 */
export function checkCodeOf(hash: string): string {
  return hash.slice(0, CHECK_CODE_LENGTH).toUpperCase();
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
 * In-process memory of the reviewed hash per user and draft. It is process-local on purpose: after a restart,
 * an expiry or an edit nothing stands as reviewed, so a pending send fails closed and is asked again. Expired
 * entries are swept on every access, so abandoned reviews do not pile up.
 */
export class DraftReviewLedger {
  readonly #reviews = new Map<string, { hash: string; expires_at: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [key, review] of this.#reviews) {
      if (review.expires_at <= now) {
        this.#reviews.delete(key);
      }
    }
  }

  /** The first review of a draft stands until it is used, changed through Aman, or expires. */
  record(input: ReviewKey & { hash: string }): void {
    this.#sweep();
    const existing = this.#reviews.get(keyOf(input));
    if (existing === undefined || existing.expires_at <= this.#now()) {
      this.#reviews.set(keyOf(input), { hash: input.hash, expires_at: this.#now() + REVIEW_TTL_MS });
    }
  }

  /** Returns and removes the reviewed hash, so one review covers one send. */
  take(key: ReviewKey): string | undefined {
    this.#sweep();
    const review = this.#reviews.get(keyOf(key));
    this.#reviews.delete(keyOf(key));
    return review?.hash;
  }

  /** An edit made through Aman voids any earlier review of that draft. */
  forget(key: ReviewKey): void {
    this.#sweep();
    this.#reviews.delete(keyOf(key));
  }
}
