import { describe, expect, it, vi } from 'vitest';

import * as staleApproval from '@/utils/staleApproval.js';
import {
  EXPIRED_REQUEST_DESCRIPTION,
  EXPIRED_REQUEST_TITLE,
  isStaleApprovalError,
  publishStaleApproval,
  subscribeToStaleApproval,
} from '@/utils/staleApproval.js';

function conflict(code: string | null, statusCode = 409): Error {
  return Object.assign(new Error('Status code: 409'), {
    statusCode,
    body: { error: { message: 'Approval continuation is stale', type: 'conflict', code } },
  });
}

describe('isStaleApprovalError', () => {
  it('matches the typed 409 the server sends for an expired approval', () => {
    expect(isStaleApprovalError(conflict('stale_approval_continuation'))).toBe(true);
  });

  it('matches the typed 409 the server sends for Approve on a request that ended', () => {
    expect(isStaleApprovalError(conflict('approval_request_ended'))).toBe(true);
  });

  it('does not match other conflicts, other statuses, or non-errors', () => {
    expect(isStaleApprovalError(conflict('approval_conflict'))).toBe(false);
    expect(isStaleApprovalError(conflict(null))).toBe(false);
    expect(isStaleApprovalError(conflict('stale_approval_continuation', 422))).toBe(false);
    expect(isStaleApprovalError(new Error('boom'))).toBe(false);
    expect(isStaleApprovalError(null)).toBe(false);
    expect(isStaleApprovalError({ statusCode: 409 })).toBe(false);
  });
});

describe('expired request copy', () => {
  it('is plain words with no ids', () => {
    expect(EXPIRED_REQUEST_TITLE).toBe('This request expired');
    expect(EXPIRED_REQUEST_DESCRIPTION).toBe(
      'The chat moved on before this was answered. Nothing was approved or run. Ask again if you still want it.',
    );
  });
});

describe('ended request copy', () => {
  it('is the one line shared by the card note and the refused answer', () => {
    // Read through Reflect so this test alone fails when the shared line is not exported.
    expect(Reflect.get(staleApproval, 'REQUEST_ENDED_LINE')).toBe(
      'This request ended. Ask again if you still need it.',
    );
  });
});

describe('stale approval signal', () => {
  it('notifies subscribers until they unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToStaleApproval(listener);
    publishStaleApproval();
    unsubscribe();
    publishStaleApproval();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
