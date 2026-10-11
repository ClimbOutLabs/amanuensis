import { approvalTokenExpiry, type ApprovalTokenScope } from '../../../src/core/permissions/approvalTokens';

/** Identity the classifier and dispatch tests run under (see makeCtx). */
export const TEST_TOKEN_SCOPE: ApprovalTokenScope = { tenant_id: 't1', created_by: 'u1' };

/** Scope and expiry a test mint passes, as the classifier does for a real call. */
export function testApprovalOwner(): ApprovalTokenScope & { expires_at: string } {
  return { ...TEST_TOKEN_SCOPE, expires_at: approvalTokenExpiry() };
}
