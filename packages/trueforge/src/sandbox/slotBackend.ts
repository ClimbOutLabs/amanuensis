import { SLOT_AGENT_SOCKET_NAME, SlotSandboxProvider, type SandboxBuild } from '@truefoundry/trueforge-core/core';
import { join } from 'node:path';
import type { Logger } from 'winston';
import configuration from '../config';

/** Capabilities and the status page poll this; one probe per window keeps them cheap. */
const STATUS_CACHE_MS = 10_000;

let cached: { at: number; build: SandboxBuild } | undefined;

export function slotsBackendEnabled(): boolean {
  return configuration.SANDBOX_BACKEND === 'slots';
}

/** Control socket of each slot agent, `<dir>/<n>/agent.sock` for n = 1..SANDBOX_SLOTS. */
export function slotSocketPaths(): string[] {
  return Array.from({ length: configuration.SANDBOX_SLOTS }, (_, index) =>
    join(configuration.SANDBOX_SLOTS_DIR, String(index + 1), SLOT_AGENT_SOCKET_NAME),
  );
}

export function createSlotSandboxProvider({ logger }: { logger: Logger }): SlotSandboxProvider {
  return new SlotSandboxProvider({
    socketPaths: slotSocketPaths(),
    defaultExecTimeoutSeconds: configuration.SANDBOX_DEFAULT_TIMEOUT_SECONDS,
    treeDiskMb: configuration.SANDBOX_SESSION_DISK_MB,
    fileMaxBytesForDownload: configuration.SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD,
    logger,
    sleepMs: undefined,
  });
}

/** Whether a slot currently proves its isolation, shared by every caller for a few seconds. */
export async function slotSandboxBuildStatus({ logger }: { logger: Logger }): Promise<SandboxBuild> {
  if (cached !== undefined && Date.now() - cached.at < STATUS_CACHE_MS) {
    return cached.build;
  }
  const build = await createSlotSandboxProvider({ logger }).getImageBuildStatus();
  cached = { at: Date.now(), build };
  return build;
}
