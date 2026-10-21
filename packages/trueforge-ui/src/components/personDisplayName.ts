import type { PersonalizationProfile } from './PersonalizationContext.js';

/** The login name the installer gives its first account. It labels a login, not a person, so it is never shown. */
const PLACEHOLDER_SIGN_IN_NAMES: ReadonlySet<string> = new Set(['owner']);

/**
 * The name to show for the person using this browser: the name they asked Aman to call them, else
 * their sign-in name. Undefined when neither is usable, so the caller leaves the name out.
 */
export function personDisplayName({
  profile,
  signInName,
}: {
  profile: Pick<PersonalizationProfile, 'address_as' | 'user_name'> | null | undefined;
  signInName: string | null | undefined;
}): string | undefined {
  const signIn = signInName?.trim() ?? '';
  const usableSignIn = PLACEHOLDER_SIGN_IN_NAMES.has(signIn.toLowerCase()) ? '' : signIn;
  for (const candidate of [profile?.address_as, profile?.user_name, usableSignIn]) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}
