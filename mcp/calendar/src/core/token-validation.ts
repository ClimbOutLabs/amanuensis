// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
// Google OAuth2 access-token validation for the HTTP transport.
//
// In HTTP mode the server never holds Google credentials of its own. The MCP
// client (e.g. TrueForge) completes the Google OAuth flow, stores the tokens,
// and forwards the Google access token as the HTTP bearer token. This module
// validates that bearer token against Google's tokeninfo endpoint and derives
// the granted scopes, which the tool layer enforces per tool.
//
// Validation results are cached by SHA-256(token) so a tokeninfo round trip
// happens at most once per token per cache TTL. The cache holds no tokens,
// only their hashes.

import { createHash } from "node:crypto";

export interface ValidatedToken {
  /** Granted scopes as full Google API URLs (space-delimited in the tokeninfo response). */
  scopes: string[];
  /** Lifetime in seconds reported by tokeninfo (0 when absent). */
  expiresIn: number;
}

/** Upper bound on cache TTL: 5 minutes, even if the token lives longer. */
const MAX_CACHE_TTL_MS = 5 * 60 * 1000;
/** Bound on cache entries so distinct tokens cannot grow the map without limit. */
const MAX_CACHE_ENTRIES = 1000;

const cache = new Map<string, { validated: ValidatedToken; cachedAtMs: number; ttlMs: number }>();

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Validate a Google access token and return its granted scopes.
 * @throws when the token is invalid, expired, or the tokeninfo call fails.
 */
export async function validateGoogleToken(token: string): Promise<ValidatedToken> {
  const key = tokenHash(token);
  const nowMs = Date.now();
  const cached = cache.get(key);
  if (cached && nowMs - cached.cachedAtMs < cached.ttlMs) {
    return cached.validated;
  }
  let response: Response;
  try {
    response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
  } catch (error) {
    throw new Error(`Token validation failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    cache.delete(key);
    throw new Error(
      response.status === 400
        ? "Token validation failed: the bearer token is invalid or expired"
        : `Token validation failed: HTTP ${response.status}`,
    );
  }
  const data = (await response.json()) as { scope?: string; expires_in?: string };
  const scopes = (data.scope ?? "").split(" ").filter(s => s.length > 0);
  const expiresIn = Number(data.expires_in ?? 0);
  const validated: ValidatedToken = { scopes, expiresIn: Number.isFinite(expiresIn) ? expiresIn : 0 };
  const ttlMs = Math.min(validated.expiresIn > 0 ? validated.expiresIn * 1000 : MAX_CACHE_TTL_MS, MAX_CACHE_TTL_MS);
  cache.set(key, { validated, cachedAtMs: nowMs, ttlMs });
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return validated;
}

/** Test seam: clears the validation cache. */
export function clearTokenValidationCache(): void {
  cache.clear();
}
