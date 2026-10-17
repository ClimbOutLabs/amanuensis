// Gmail API OAuth2 scope definitions and helpers
//
// Scope hierarchy (for reference):
//   - gmail.readonly: Read-only access to emails
//   - gmail.modify: Read, change labels, archive AND send (Google lists it as
//     sufficient for messages.send and drafts.send); no permanent deletion
//   - gmail.compose: Create drafts and send emails
//   - gmail.send: Send emails only
//   - gmail.labels: Manage labels only
//   - gmail.full: Full mailbox access, including permanent deletion
//   - gmail.settings.basic: Manage filters and settings
//
// Note: gmail.modify includes all capabilities of gmail.readonly,
// so you don't need both scopes together.

// Map shorthand scope names to full Google API URLs
export const SCOPE_MAP: Record<string, string> = {
  "gmail.readonly": "https://www.googleapis.com/auth/gmail.readonly",
  "gmail.modify": "https://www.googleapis.com/auth/gmail.modify",
  "gmail.compose": "https://www.googleapis.com/auth/gmail.compose",
  "gmail.send": "https://www.googleapis.com/auth/gmail.send",
  "gmail.labels": "https://www.googleapis.com/auth/gmail.labels",
  "gmail.full": "https://mail.google.com/",
  "gmail.settings.basic": "https://www.googleapis.com/auth/gmail.settings.basic",
  "gmail.settings.sharing": "https://www.googleapis.com/auth/gmail.settings.sharing",
};

// Reverse map for converting full URLs back to shorthand
export const SCOPE_REVERSE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SCOPE_MAP).map(([short, full]) => [full, short]),
);

// Default scopes: read only. Anything that changes mail (gmail.modify), sends
// (gmail.compose / gmail.send) or edits settings is a separate, explicit grant.
export const DEFAULT_SCOPES = ["gmail.readonly"];

// Plain-words labels shown to users when they pick scopes. Kept next to the
// scope map so what we show cannot drift from what Google allows.
export const SCOPE_LABELS: Record<string, string> = {
  "gmail.readonly": "Read mail only. Cannot change, archive or send.",
  "gmail.modify":
    "Read, mark read, archive and label. Google also lets this permission SEND mail. Cannot permanently delete.",
  "gmail.compose": "Create drafts and SEND mail. Includes what gmail.send allows.",
  "gmail.send": "Send mail only. Cannot read.",
  "gmail.labels": "Create and edit labels only.",
  "gmail.full":
    "Everything, including sending and permanent deletion. Does not include settings.",
  "gmail.settings.basic":
    "Manage filters and basic settings. Filters can move, hide or forward mail.",
  "gmail.settings.sharing": "Manage delegation and sharing settings (rare).",
};

// Scopes that let Google accept a send even though the user only asked to read.
// Scopes this app accepts for drafting and sending.
const SEND_TOOL_SCOPES = ["gmail.compose", "gmail.send"];

const WIDER_THAN_READ_SCOPES = ["gmail.modify", "gmail.full"];

/**
 * Plain-words notice for a stored connection that holds a send-capable
 * read/write scope, or null when there is nothing to tell the owner.
 */
export function wideScopeNotice({
  scopes,
  accountId,
}: {
  scopes: string[];
  accountId: string | null;
}): string | null {
  const held = scopes.map(scopeUrlToName).filter((s) => WIDER_THAN_READ_SCOPES.includes(s));
  if (held.length === 0) return null;
  const account = accountId ?? "default";
  const base = `This Gmail connection (${held.join(", ")}) can send email as you, not only read it.`;
  const readOnly = `To switch to read-only, reconnect with: gmail account auth ${account} --scopes=gmail.readonly`;
  if (hasScope(scopes, SEND_TOOL_SCOPES)) return `${base} ${readOnly}`;
  return (
    `${base} Drafting and sending are switched off in this app because compose permission was never granted. ` +
    `${readOnly}. To turn drafting and sending on and keep labels and archive, reconnect with: ` +
    `gmail account auth ${account} --scopes=gmail.readonly,gmail.modify,gmail.compose`
  );
}

// Least-privilege fallback used when a credential store carries NO scope
// list at all (scopes absent, not scopes === []). A missing list means we
// cannot prove the user granted write access, so the server enforces
// read-only until a credential with an explicit scope list is loaded.
// DEFAULT_SCOPES stays as the interactive/non-interactive OAuth *request*
// default (auth-scopes.ts); it must never be used as an enforcement default.
export const READONLY_FALLBACK_SCOPES = ["gmail.readonly"];

// Convert shorthand scope name to full Google API URL
// e.g., "gmail.readonly" -> "https://www.googleapis.com/auth/gmail.readonly"
export function scopeNameToUrl(scope: string): string {
  return SCOPE_MAP[scope] || scope;
}

// Convert full Google API URL to shorthand name
// e.g., "https://www.googleapis.com/auth/gmail.readonly" -> "gmail.readonly"
export function scopeUrlToName(scope: string): string {
  return SCOPE_REVERSE_MAP[scope] || scope;
}

// Convert array of shorthand scope names to full Google API URLs
export function scopeNamesToUrls(scopes: string[]): string[] {
  return scopes.map(scopeNameToUrl);
}

// Check if the authorized scopes grant access to a tool
// Returns true if the tool requires no scopes, or if ANY of the tool's
// required scopes are present in authorizedScopes.
export function hasScope(authorizedScopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0) return true; // tools that need no Gmail scope (e.g. health_check)
  // Normalize to shorthand names for comparison (handles both URL and shorthand input)
  const normalizedAuth = authorizedScopes.map(scopeUrlToName);
  const fullMailScopes = new Set([
    "gmail.readonly",
    "gmail.modify",
    "gmail.compose",
    "gmail.send",
    "gmail.labels",
    "gmail.full",
  ]);
  const hasFull = normalizedAuth.includes("gmail.full");
  return requiredScopes.some(
    (scope) => normalizedAuth.includes(scope) || (hasFull && fullMailScopes.has(scope)),
  );
}

// Parse scope input from CLI (comma-separated or space-separated)
export function parseScopes(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Validate that all scopes are recognized
export function validateScopes(scopes: string[]): { valid: boolean; invalid: string[] } {
  const invalid = scopes.filter((s) => !SCOPE_MAP[s]);
  return { valid: invalid.length === 0, invalid };
}

// Get available scope names for help text
export function getAvailableScopeNames(): string[] {
  return Object.keys(SCOPE_MAP);
}
