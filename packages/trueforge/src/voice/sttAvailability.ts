/**
 * Cached STT sidecar availability backing `capabilities.voice`. The flag is
 * computed from a non-blocking `/healthz` probe at backend startup and refreshed
 * on a background 30s interval, so a recovered sidecar flips the flag without a
 * backend restart. Until the first probe resolves the flag reads false, keeping
 * the mic hidden until the check completes.
 */
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import configuration from '../config';

const STT_HEALTH_TIMEOUT_MS = 2_000;
const STT_HEALTH_CHECK_INTERVAL_MS = 30_000;

export function sttBaseUrl(): string {
  return configuration.STT_URL.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Probes the sidecar health endpoint once. Resolves true only when the sidecar
 * answers 200 with a loaded model; any failure degrades to false. Probe failures
 * are logged; transcripts never are (the probe reads no audio).
 */
export async function probeSttHealth(deps: { logger: Logger }): Promise<boolean> {
  try {
    const response = await fetch(`${sttBaseUrl()}/healthz`, {
      signal: AbortSignal.timeout(STT_HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return false;
    }
    const body: unknown = await response.json();
    return isRecord(body) && body['model_loaded'] === true;
  } catch (error) {
    deps.logger.info('STT health probe failed', extractErrorLogFields(error));
    return false;
  }
}

let voiceAvailable = false;
let watcherStarted = false;

/** Latest cached STT availability; false until the first probe resolves. */
export function isVoiceAvailable(): boolean {
  return voiceAvailable;
}

/**
 * Starts the non-blocking STT health watcher: one probe immediately, then every
 * 30s. Fire-and-forget; startup never waits. Idempotent, safe to call once at boot.
 */
export function startSttAvailabilityWatcher(deps: { logger: Logger }): void {
  if (watcherStarted) {
    return;
  }
  watcherStarted = true;
  const check = async (): Promise<void> => {
    voiceAvailable = await probeSttHealth(deps);
  };
  void check();
  const timer = setInterval(() => {
    void check();
  }, STT_HEALTH_CHECK_INTERVAL_MS);
  timer.unref();
}
