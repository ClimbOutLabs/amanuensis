import { buildBriefingPrompt } from '../../../src/runtime/briefingTemplates';

describe('buildBriefingPrompt', () => {
  it('builds the morning briefing prompt with required sections', () => {
    const prompt = buildBriefingPrompt('morning-briefing');
    expect(prompt).toContain('calendar');
    expect(prompt).toContain('Overnight');
    expect(prompt).toContain('Priorities');
    expect(prompt).toContain('Weather');
  });

  it('instructs the agent to use tools for current information', () => {
    const prompt = buildBriefingPrompt('morning-briefing');
    expect(prompt.toLowerCase()).toContain('tool');
  });

  it('throws for an unknown template instead of resolving to no prompt', () => {
    expect(() => buildBriefingPrompt('evening-briefing' as never)).toThrow('Unknown briefing template');
  });
});
