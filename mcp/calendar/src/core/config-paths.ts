// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
// Config/state path resolution for the calendar MCP server.
//
//   CALENDAR_CONFIG_DIR - base directory for credentials. Defaults to
//   ~/.calendar-mcp. In Docker, the image sets this to /calendar-server so a
//   volume mount persists credentials across restarts.

import os from "node:os";
import path from "node:path";

export function getConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CALENDAR_CONFIG_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".calendar-mcp");
}

/** Path of the stored OAuth credentials file: <configDir>/credentials.json. */
export function getCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDir(env), "credentials.json");
}
