import {
  toolOutputScreen,
  type AgentCapability,
  type ToolOutputScreenClassifier,
} from '@truefoundry/trueforge-core/core';
import { ScreenClient } from './memory/screenClient';

export interface ToolOutputScreenConfig {
  enabled: boolean;
  url: string;
  authToken: string;
  threshold: number;
  timeoutMs: number;
}

/** Builds the post-dispatch screen capability only when the operator explicitly enables it. */
export function toolOutputScreenCapability(input: {
  config: ToolOutputScreenConfig;
  classifier?: ToolOutputScreenClassifier | undefined;
}): AgentCapability | undefined {
  if (!input.config.enabled) {
    return undefined;
  }
  const classifier =
    input.classifier ??
    new ScreenClient({
      url: input.config.url,
      authToken: input.config.authToken,
      threshold: input.config.threshold,
    });
  return toolOutputScreen({ classifier, timeoutMs: input.config.timeoutMs });
}
