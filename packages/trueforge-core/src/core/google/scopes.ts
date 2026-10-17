/**
 * Canonical owner of what Aman may ask a Google account for. A feature is the unit the user sees and
 * the tools are gated on; each maps to the narrowest scope that covers it. Never a full-mailbox or
 * full-calendar scope.
 */
export const GOOGLE_FEATURES = ['gmail_read', 'gmail_compose'] as const;
export type GoogleFeature = (typeof GOOGLE_FEATURES)[number];

interface GoogleFeatureInfo {
  scope: string;
  label: string;
}

const FEATURE_INFO: Record<GoogleFeature, GoogleFeatureInfo> = {
  gmail_read: {
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    label: 'Read and search your email',
  },
  gmail_compose: {
    scope: 'https://www.googleapis.com/auth/gmail.compose',
    label: 'Save drafts and send email you approve',
  },
};

export function googleFeatureLabel(feature: GoogleFeature): string {
  return FEATURE_INFO[feature].label;
}

/** Scope URLs for the features, in feature order and without repeats. */
export function scopesForFeatures(features: readonly GoogleFeature[]): string[] {
  return GOOGLE_FEATURES.filter(feature => features.includes(feature)).map(feature => FEATURE_INFO[feature].scope);
}

/** The features Google actually granted, read off the scope list it returned. */
export function grantedFeatures(scopes: readonly string[]): GoogleFeature[] {
  return GOOGLE_FEATURES.filter(feature => scopes.includes(FEATURE_INFO[feature].scope));
}
