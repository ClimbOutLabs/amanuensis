// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
// Config/state path resolution for the tasks MCP server.
//
//   TASKS_CONFIG_DIR - base directory for credentials. Defaults to
//   ~/.tasks-mcp. In Docker, the image sets this to /tasks-server so a
//   volume mount persists credentials across restarts.

import os from "node:os";
import path from "node:path";

export function getConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TASKS_CONFIG_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".tasks-mcp");
}

/** Path of the stored OAuth credentials file: <configDir>/credentials.json. */
export function getCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDir(env), "credentials.json");
}
