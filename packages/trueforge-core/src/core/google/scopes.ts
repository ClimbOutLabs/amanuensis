/**
 * Canonical owner of what Aman may ask a Google account for. A feature is the unit the user sees and
 * the tools are gated on; each maps to the narrowest scope that covers it. Never a full-mailbox or
 * full-calendar scope: calendar access is limited to events, and Drive access to the files Aman
 * created or the person opened with Aman.
 */
export const GOOGLE_FEATURES = [
  'gmail_read',
  'gmail_compose',
  'calendar_read',
  'calendar_write',
  'drive_files',
] as const;
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
  calendar_read: {
    scope: 'https://www.googleapis.com/auth/calendar.events.readonly',
    label: 'Read events on your calendar',
  },
  calendar_write: {
    scope: 'https://www.googleapis.com/auth/calendar.events',
    label: 'Add and change events you approve',
  },
  // One feature for Drive: the drive.file scope itself covers reading and writing, and it reaches only
  // the files Aman created or the person opened with Aman. Never the full drive scope, which is restricted.
  drive_files: {
    scope: 'https://www.googleapis.com/auth/drive.file',
    label: 'Read and add to Drive files Aman created or you opened with Aman',
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
