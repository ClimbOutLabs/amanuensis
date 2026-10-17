import type { AgentCapability, ToolCallResult, ToolResponseProcessor } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { ITurnArtifactStore } from '../../db/turnArtifactStore';
import { PERSISTED_ARTIFACT_MIME } from '../artifacts/persistTurnArtifacts';
import { imageTypeFromContentType, type ChatImageInputType } from './imageSniff';
import { CHAT_IMAGE_LOCAL_MAX_BYTES, CHAT_IMAGE_MAX_PER_TOOL_RESULT } from './limits';

/** Path namespace for images a tool returned, next to `run_code/` harvests in the turn artifact store. */
export const TOOL_IMAGE_PATH_PREFIX = 'tool_images/';

const EXTENSION: Record<ChatImageInputType, string> = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' };

class ToolImagesProcessor implements ToolResponseProcessor {
  readonly #options: ToolImagesOptions;

  constructor(options: ToolImagesOptions) {
    this.#options = options;
  }

  async process(results: ToolCallResult[]): Promise<Record<string, never>> {
    const { store, tenantId, sessionId, turnId, logger } = this.#options;
    for (const result of results) {
      if (result.failure) {
        continue;
      }
      const toolCallId = result.message.tool_call_id;
      for (const [index, image] of result.images.slice(0, CHAT_IMAGE_MAX_PER_TOOL_RESULT).entries()) {
        const type = imageTypeFromContentType(image.mime);
        if (type === null || image.data.byteLength > CHAT_IMAGE_LOCAL_MAX_BYTES) {
          continue;
        }
        const name = `image-${String(index + 1)}.${EXTENSION[type]}`;
        try {
          await store.recordStoredArtifact({
            tenant_id: tenantId,
            session_id: sessionId,
            turn_id: turnId,
            path: `${TOOL_IMAGE_PATH_PREFIX}${toolCallId}/${name}`,
            name,
            data: image.data,
            mime: PERSISTED_ARTIFACT_MIME,
          });
        } catch (error) {
          // Best effort: the tool result already reached the model; only the picture is missing.
          logger.warn('Could not keep an image a tool returned', {
            sessionId,
            turnId,
            toolCallId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return {};
  }
}

export interface ToolImagesOptions {
  store: Pick<ITurnArtifactStore, 'recordStoredArtifact'>;
  tenantId: string;
  sessionId: string;
  turnId: string;
  logger: Logger;
}

/**
 * Keeps the allow-listed images a tool returned (for example an email attachment) as turn artifacts,
 * so the chat can show them after the sandbox re-encodes them. Their bytes never reach the model.
 */
export function toolImagesCapability(options: ToolImagesOptions): AgentCapability {
  return { toolResponseProcessors: [new ToolImagesProcessor(options)] };
}
