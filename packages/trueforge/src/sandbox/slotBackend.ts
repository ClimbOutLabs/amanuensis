import {
  execFileRunner,
  extractErrorLogFields,
  GitBridge,
  rawSandboxId,
  SlotSandboxProvider,
  slotSocketPathsIn,
  type SandboxBuild,
} from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';
import configuration from '../config';

/** Capabilities and the status page poll this; one probe per window keeps them cheap. */
const STATUS_CACHE_MS = 10_000;

let cached: { at: number; build: SandboxBuild } | undefined;
/** One bridge per process, so a reviewed push is still remembered when the next request builds a new provider. */
let sharedGitBridge: GitBridge | undefined;

function gitBridge({ logger }: { logger: Logger }): GitBridge {
  sharedGitBridge ??= new GitBridge({
    scratchRoot: configuration.SANDBOX_GIT_BRIDGE_DIR,
    runner: execFileRunner,
    logger: logger.child({ module: 'git-bridge' }),
    remoteUrl: undefined,
    networkEntries: undefined,
    networkEnv: configuration.SANDBOX_GIT_NETWORK_ENV,
    scratchCapBytes: undefined,
    now: undefined,
  });
  return sharedGitBridge;
}

export function slotsBackendEnabled(): boolean {
  return configuration.SANDBOX_BACKEND === 'slots';
}

/** An installer instance set up without the sandbox: no slots and no image, off by choice rather than misconfigured. */
export function sandboxDisabledByInstaller(): boolean {
  return configuration.INSTALLER_INSTANCE !== '' && !slotsBackendEnabled() && configuration.SANDBOX_IMAGE.trim() === '';
}

/** Control socket of each slot agent, `<dir>/<n>/agent.sock` for n = 1..SANDBOX_SLOTS. */
export function slotSocketPaths(): string[] {
  return slotSocketPathsIn({ dir: configuration.SANDBOX_SLOTS_DIR, count: configuration.SANDBOX_SLOTS });
}

export function createSlotSandboxProvider({ logger }: { logger: Logger }): SlotSandboxProvider {
  return new SlotSandboxProvider({
    socketPaths: slotSocketPaths(),
    defaultExecTimeoutSeconds: configuration.SANDBOX_DEFAULT_TIMEOUT_SECONDS,
    treeDiskMb: configuration.SANDBOX_SESSION_DISK_MB,
    fileMaxBytesForDownload: configuration.SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD,
    logger,
    sleepMs: undefined,
    gitBridge: gitBridge({ logger }),
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

/** Removes a deleted chat's workspace from its slot; if that fails the agent's idle sweep removes it later. */
export async function removeSlotWorkspace({ sandboxId, logger }: { sandboxId: string; logger: Logger }): Promise<void> {
  try {
    await createSlotSandboxProvider({ logger }).destroySandbox({ sandboxId: rawSandboxId(sandboxId) });
  } catch (error) {
    logger.warn('Could not remove the sandbox workspace of a deleted chat', extractErrorLogFields(error));
  }
}
