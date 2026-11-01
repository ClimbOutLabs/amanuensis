import { DEFAULT_MODEL_TOOL_CALL_IDLE_TIMEOUT_MS } from '@truefoundry/trueforge-core/core/llm/streamDeadline';
import { DEFAULT_MODEL_IDLE_TIMEOUT_MS } from '@truefoundry/trueforge-core/core/runtime/AgentThread';
import configuration from '../../../src/config';

describe('model silence bounds', () => {
  it('keep the server defaults in step with the core defaults', () => {
    expect(configuration.MODEL_STREAM_IDLE_TIMEOUT_MS).toBe(DEFAULT_MODEL_IDLE_TIMEOUT_MS);
    expect(configuration.MODEL_STREAM_TOOL_CALL_IDLE_TIMEOUT_MS).toBe(DEFAULT_MODEL_TOOL_CALL_IDLE_TIMEOUT_MS);
  });

  it('give an open tool call three minutes, longer than ordinary answering', () => {
    expect(configuration.MODEL_STREAM_TOOL_CALL_IDLE_TIMEOUT_MS).toBe(180_000);
    expect(configuration.MODEL_STREAM_TOOL_CALL_IDLE_TIMEOUT_MS).toBeGreaterThan(
      configuration.MODEL_STREAM_IDLE_TIMEOUT_MS,
    );
  });
});
