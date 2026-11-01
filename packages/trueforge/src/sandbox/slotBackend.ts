import {
  execFileRunner,
  extractErrorLogFields,
  forgetShownSkillNotices,
  GitBridge,
  rawSandboxId,
  slotMirrorSocketPathsIn,
  SlotSandboxProvider,
  slotSkillNetworkSocketPathsIn,
  slotSocketPathsIn,
  type AuditLogWriter,
  type SandboxBuild,
} from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';
import configuration from '../config';
import { PackageMirrorGateway } from './mirrors/packageMirrorGateway';
import { packageMirrorTokens } from './mirrors/packageMirrorTokens';
import { SkillNetworkGateway } from './skillnet/skillNetworkGateway';
import { skillNetworkTokens } from './skillnet/skillNetworkTokens';

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

/** Package mirror socket of each slot, `<dir>/<n>/mirror/mirror.sock`: where the slot agent reaches the mirrors. */
export function slotMirrorSocketPaths(): string[] {
  return slotMirrorSocketPathsIn({ dir: configuration.SANDBOX_SLOTS_DIR, count: configuration.SANDBOX_SLOTS });
}

/** Skill network socket of each slot, `<dir>/<n>/mirror/skillnet.sock`: where the slot agent reaches the skill network gateway. */
export function slotSkillNetworkSocketPaths(): string[] {
  return slotSkillNetworkSocketPathsIn({
    dir: configuration.SANDBOX_SLOTS_DIR,
    count: configuration.SANDBOX_SLOTS,
  });
}

let mirrorGatewayStarted = false;

/**
 * Starts the download-only package mirrors on their per-slot sockets. Best effort by design: when
 * the sockets cannot be opened, package downloads stay unavailable and every other sandbox call
 * keeps working offline, so a mirror problem never takes the sandbox down.
 */
export async function startPackageMirrorGateway({ logger }: { logger: Logger }): Promise<void> {
  if (mirrorGatewayStarted || !slotsBackendEnabled()) {
    return;
  }
  mirrorGatewayStarted = true;
  try {
    const gateway = new PackageMirrorGateway({
      registry: packageMirrorTokens,
      cacheDir: configuration.SANDBOX_MIRROR_CACHE_DIR,
      logger: logger.child({ module: 'package-mirrors' }),
      maxDownloadBytes: configuration.SANDBOX_MIRROR_DOWNLOAD_MAX_BYTES,
      maxCacheBytes: configuration.SANDBOX_MIRROR_CACHE_MAX_BYTES,
    });
    await gateway.listenOnSockets(slotMirrorSocketPaths());
    logger.info('Package mirrors are listening for the sandbox slots');
  } catch (error) {
    logger.warn('Package mirrors could not start; sandbox package downloads stay off', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let skillNetworkGatewayStarted = false;

/**
 * Starts the skill network gateway on its per-slot sockets. Best effort, like the mirrors: when
 * the sockets cannot be opened, approved skill sites stay unreachable and every other sandbox
 * call keeps working, so a gateway problem never takes the sandbox down.
 */
export async function startSkillNetworkGateway({
  logger,
  audit,
}: {
  logger: Logger;
  audit?: AuditLogWriter | null | undefined;
}): Promise<void> {
  if (skillNetworkGatewayStarted || !slotsBackendEnabled()) {
    return;
  }
  skillNetworkGatewayStarted = true;
  try {
    const gateway = new SkillNetworkGateway({
      registry: skillNetworkTokens,
      logger: logger.child({ module: 'skill-network' }),
      audit: audit ?? null,
    });
    await gateway.listenOnSockets(slotSkillNetworkSocketPaths());
    logger.info('Skill network gateway is listening for the sandbox slots');
  } catch (error) {
    logger.warn('Skill network gateway could not start; approved skill sites stay unreachable', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
    forgetShownSkillNotices(rawSandboxId(sandboxId));
  } catch (error) {
    logger.warn('Could not remove the sandbox workspace of a deleted chat', extractErrorLogFields(error));
  }
}
