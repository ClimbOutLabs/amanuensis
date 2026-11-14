import type { ApprovedMailDrafts } from '../../../src/core/email/mailConnector/approvedDrafts';

/** Stands for a person who approved the draft of every message, for tests about the send step alone. */
export const everyMailDraftApproved: ApprovedMailDrafts = {
  has: () => Promise.resolve(true),
  add: () => Promise.resolve(),
  remove: () => Promise.resolve(),
};
