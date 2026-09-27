// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
// Google Tasks OAuth2 scope definitions and helpers.
//
// Scope hierarchy (for reference):
//   - tasks.readonly: Read-only access to task lists and tasks
//   - tasks:          Full access to task lists and tasks (superset of readonly)
//
// The server requests the minimal set by default: tasks.readonly + tasks.
// (Google Tasks has no narrower write scope, so both are requested together;
// tools the granted scopes do not cover are refused at call time.)

/** Shorthand scope names mapped to full Google API URLs. */
export const SCOPE_MAP: Record<string, string> = {
  "tasks.readonly": "https://www.googleapis.com/auth/tasks.readonly",
  "tasks": "https://www.googleapis.com/auth/tasks",
};

/** Reverse map for converting full URLs back to shorthand. */
export const SCOPE_REVERSE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SCOPE_MAP).map(([short, full]) => [full, short]),
);

/** Minimal scopes requested by the interactive OAuth flow. */
export const DEFAULT_SCOPES = ["tasks.readonly", "tasks"];

/**
 * Least-privilege fallback when a credential store carries NO scope list at
 * all (scopes absent, not scopes === []). A missing list means we cannot
 * prove the user granted write access, so the server enforces read-only
 * until a credential with an explicit scope list is loaded. DEFAULT_SCOPES
 * is the OAuth *request* default; it must never be used as an enforcement
 * default.
 */
export const READONLY_FALLBACK_SCOPES = ["tasks.readonly"];

/** Shorthand name to full Google API URL. */
export function scopeNameToUrl(scope: string): string {
  return SCOPE_MAP[scope] || scope;
}

/** Full Google API URL to shorthand name. */
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
 * scopes is present in authorizedScopes. The full `tasks` scope implies
 * `tasks.readonly`.
 */
export function hasScope(authorizedScopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0) return true;
  const normalizedAuth = authorizedScopes.map(scopeUrlToName);
  if (normalizedAuth.includes("tasks")) return true;
  return requiredScopes.some((scope) => normalizedAuth.includes(scope));
}
