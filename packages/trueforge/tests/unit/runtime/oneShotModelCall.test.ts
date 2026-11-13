import { shortCallRequestFields } from '../../../src/runtime/oneShotModelCall';

describe('shortCallRequestFields', () => {
  it('turns thinking off and keeps the cap when the model can switch thinking off', () => {
    expect(
      shortCallRequestFields({ modelProperties: { reasoning_efforts: ['none', 'low', 'high'] }, maxTokens: 300 }),
    ).toEqual({ max_completion_tokens: 300, reasoning: { enable_thinking: false, reasoning_effort: 'none' } });
  });

  it('asks for the least thinking and adds room when thinking cannot be switched off', () => {
    expect(shortCallRequestFields({ modelProperties: { reasoning_efforts: ['low', 'high'] }, maxTokens: 300 })).toEqual(
      { max_completion_tokens: 1324, reasoning: { reasoning_effort: 'low' } },
    );
  });

  it('adds room and sends no reasoning field when the model lists no efforts', () => {
    expect(shortCallRequestFields({ modelProperties: {}, maxTokens: 300 })).toEqual({
      max_completion_tokens: 1324,
      reasoning: {},
    });
  });

  it('never asks for more than the model can write', () => {
    expect(shortCallRequestFields({ modelProperties: { max_output_tokens: 512 }, maxTokens: 300 })).toEqual({
      max_completion_tokens: 512,
      reasoning: {},
    });
  });
});
