// Centralized config-path resolution for Gmail-MCP-Server.
//
// Single source of truth for where on the filesystem credentials and config
// live. All paths are env-overridable so a deployment can mount a volume or
// run fully env-driven (no filesystem state) — see Phase F in the plan.
//
// Resolution order for the config directory:
//   1. GMAIL_CONFIG_DIR  — explicit override (e.g. /var/lib/gmail-mcp in Docker).
//   2. ~/.gmail-mcp/     — historical default.
//
// Per-file env overrides bypass the directory entirely:
//   GMAIL_OAUTH_PATH         — full path to gcp-oauth.keys.json
//   GMAIL_CREDENTIALS_PATH   — full path to credentials.json

import os from "node:os";
import path from "node:path";

export function getConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GMAIL_CONFIG_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".gmail-mcp");
}

export function getOAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GMAIL_OAUTH_PATH;
  if (override && override.trim().length > 0) return override;
  return path.join(getConfigDir(env), "gcp-oauth.keys.json");
}

export function getCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GMAIL_CREDENTIALS_PATH;
  if (override && override.trim().length > 0) return override;
  return path.join(getConfigDir(env), "credentials.json");
}

/** Where TUI compose drafts persist (`<configDir>/drafts/`). Drafts survive
    aborts and failed sends; only a verified successful send removes one. */
export function getDraftsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDir(env), "drafts");
}

/**
 * Sandbox root for READS of caller-supplied file paths (send_email
 * attachments, html_body inline images). All such paths resolve inside this
 * directory; symlinks that escape it are rejected.
 *
 * Env: GMAIL_ATTACHMENTS_DIR (default `<configDir>/attachments`).
 */
export function getAttachmentsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GMAIL_ATTACHMENTS_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(getConfigDir(env), "attachments");
}

/**
 * Sandbox root for WRITES of caller-supplied download destinations
 * (download_attachment / download_email savePath).
 *
 * Env: GMAIL_DOWNLOADS_DIR (default `<configDir>/downloads`).
 */
export function getDownloadsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GMAIL_DOWNLOADS_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(getConfigDir(env), "downloads");
}
