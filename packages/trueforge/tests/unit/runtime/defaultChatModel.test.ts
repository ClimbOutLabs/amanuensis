import { newChatAgentSpec } from '../../../src/runtime/defaultChatModel';
import type { AvailableModel } from '../../../src/schemas/modelProvider';

function model(properties: AvailableModel['properties']): AvailableModel {
  return {
    name: 'local/model-a',
    model_id: 'model-a',
    provider: { name: 'local' },
    properties,
  };
}

describe('the assistant a new chat starts on, made on the server', () => {
  it('runs on the default model, at the app’s default reasoning effort, with the sandbox as the server has it', () => {
    expect(
      newChatAgentSpec({ model: model({ reasoning_efforts: ['none', 'low', 'high'] }), sandbox: true }),
    ).toMatchObject({
      model: { name: 'local/model-a', params: { reasoning_effort: 'low' } },
      config: { sandbox: { enabled: true } },
    });
    expect(
      newChatAgentSpec({ model: model({ reasoning_efforts: ['none', 'low', 'medium'] }), sandbox: false })?.model
        .params,
    ).toEqual({ reasoning_effort: 'medium' });
    expect(newChatAgentSpec({ model: model({}), sandbox: false })).toMatchObject({
      model: { name: 'local/model-a' },
      config: { sandbox: { enabled: false } },
    });
    expect(newChatAgentSpec({ model: model({}), sandbox: false })?.model.params).toBeUndefined();
  });

  it('starts with the same skills a new chat in the app starts with, when the sandbox they need is there', () => {
    expect(newChatAgentSpec({ model: model({}), sandbox: true })?.skills).toEqual([
      { name: 'web-artifacts-builder', preload: false },
    ]);
    expect(newChatAgentSpec({ model: model({}), sandbox: false })?.skills).toBeUndefined();
  });

  it('is none when the server has no model', () => {
    expect(newChatAgentSpec({ model: undefined, sandbox: true })).toBeUndefined();
  });
});
