// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
// Google Calendar OAuth2 scope definitions and helpers.
//
// Scope hierarchy (for reference):
//   - calendar.readonly: Read-only access to calendars and events
//   - calendar.events:   Read/write access to events (not calendar settings/sharing)
//   - calendar:          Full access to calendars (superset of both above)
//
// The server requests the minimal set by default: calendar.readonly +
// calendar.events. The broader `calendar` scope is only needed for
// calendar-list management, which this server does not do.

/** Shorthand scope names mapped to full Google API URLs. */
export const SCOPE_MAP: Record<string, string> = {
  "calendar.readonly": "https://www.googleapis.com/auth/calendar.readonly",
  "calendar.events": "https://www.googleapis.com/auth/calendar.events",
  "calendar": "https://www.googleapis.com/auth/calendar",
};

/** Reverse map for converting full URLs back to shorthand. */
export const SCOPE_REVERSE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SCOPE_MAP).map(([short, full]) => [full, short]),
);

/**
 * Minimal scopes requested by the interactive OAuth flow: read events and
 * manage events, nothing broader. Calendar-list management would need the
 * full `calendar` scope, which this server never requests.
 */
export const DEFAULT_SCOPES = ["calendar.readonly", "calendar.events"];

/**
 * Least-privilege fallback when a credential store carries NO scope list at
 * all (scopes absent, not scopes === []). A missing list means we cannot
 * prove the user granted write access, so the server enforces read-only
 * until a credential with an explicit scope list is loaded. DEFAULT_SCOPES
 * is the OAuth *request* default; it must never be used as an enforcement
 * default.
 */
export const READONLY_FALLBACK_SCOPES = ["calendar.readonly"];

/** Shorthand name to full Google API URL, e.g. "calendar.readonly" -> "https://www.googleapis.com/auth/calendar.readonly". */
export function scopeNameToUrl(scope: string): string {
  return SCOPE_MAP[scope] || scope;
}

/** Full Google API URL to shorthand name, e.g. "https://www.googleapis.com/auth/calendar.readonly" -> "calendar.readonly". */
export function scopeUrlToName(scope: string): string {
  return SCOPE_REVERSE_MAP[scope] || scope;
}

/** Array of shorthand scope names to full Google API URLs. */
export function scopeNamesToUrls(scopes: string[]): string[] {
  return scopes.map(scopeNameToUrl);
}

/**
 * Check whether the authorized scopes grant access to a tool. Returns true
 * when the tool requires no scopes, or when ANY of the tool's required
 * scopes is present in authorizedScopes. The full `calendar` scope implies
 * both `calendar.readonly` and `calendar.events`.
 */
export function hasScope(authorizedScopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0) return true;
  const normalizedAuth = authorizedScopes.map(scopeUrlToName);
  if (normalizedAuth.includes("calendar")) return true;
  return requiredScopes.some((scope) => normalizedAuth.includes(scope));
}
