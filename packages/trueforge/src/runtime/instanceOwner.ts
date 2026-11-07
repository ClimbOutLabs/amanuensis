import type { OIDCConfig } from '../config';

/**
 * The one person the instance-wide connectors (Email and Calendar sidecars) belong to. With sign-in off that is the
 * default person. With sign-in on it is the single address the owner signs in with, when people are told apart by
 * email. Otherwise the result is undefined and no one is given the shared connectors.
 */
export function instanceOwnerSubjectId({
  signInOff,
  defaultSubjectId,
  oidc,
}: {
  signInOff: boolean;
  defaultSubjectId: string;
  oidc: Pick<OIDCConfig, 'OIDC_USER_REFERENCE_CLAIM' | 'OIDC_ALLOWED_EMAILS'> | undefined;
}): string | undefined {
  return signInOff ? defaultSubjectId : oidcOwnerSubjectId(oidc);
}

/**
 * The owner sign-in names: the single allowed address, when people are told apart by email. Several addresses, a
 * pattern or another claim name no owner.
 */
export function oidcOwnerSubjectId(
  oidc: Pick<OIDCConfig, 'OIDC_USER_REFERENCE_CLAIM' | 'OIDC_ALLOWED_EMAILS'> | undefined,
): string | undefined {
  const allowed = oidc?.OIDC_USER_REFERENCE_CLAIM === 'email' ? oidc.OIDC_ALLOWED_EMAILS : [];
  const [only] = allowed;
  return allowed.length === 1 && only !== undefined && !only.includes('*') ? only : undefined;
}
