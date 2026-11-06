import { DEFAULT_NEW_CHAT_SKILLS, defaultReasoningEffort } from '../../src/agent-session/newChatDefaults';

describe('what a new chat starts on', () => {
  it('starts at "medium" when the model offers it, in whatever order the efforts are listed', () => {
    expect(defaultReasoningEffort(['none', 'low', 'medium', 'high'])).toBe('medium');
    expect(defaultReasoningEffort(['xhigh', 'medium', 'low'])).toBe('medium');
  });

  it('else starts at the lowest real effort listed, never "none" when there is another', () => {
    expect(defaultReasoningEffort(['none', 'low', 'high'])).toBe('low');
    expect(defaultReasoningEffort(['none', 'minimal', 'low'])).toBe('minimal');
    expect(defaultReasoningEffort(['none'])).toBe('none');
  });

  it('has no effort for a model that lists none', () => {
    expect(defaultReasoningEffort([])).toBeUndefined();
    expect(defaultReasoningEffort(undefined)).toBeUndefined();
    expect(defaultReasoningEffort(null)).toBeUndefined();
  });

  it('starts with the page-building skill', () => {
    expect(DEFAULT_NEW_CHAT_SKILLS).toEqual(['web-artifacts-builder']);
  });
});
