import { isMorningBriefPrompt, MORNING_BRIEF_PROMPT } from '../../../src/core/schedules/morningBrief';

describe('MORNING_BRIEF_PROMPT', () => {
  it('is the one brief prompt: four numbered steps that ask for sources and never send or save', () => {
    expect(
      MORNING_BRIEF_PROMPT.startsWith('Give me my morning brief. 1. Read everything new since my last brief'),
    ).toBe(true);
    for (const step of [
      ' 2. Write four short sections',
      ' 3. Say where each item came from',
      ' 4. If something could not be read',
    ]) {
      expect(MORNING_BRIEF_PROMPT).toContain(step);
    }
    expect(MORNING_BRIEF_PROMPT).toContain('do not send or save anything without asking me');
  });

  it('asks for one next step per line, written as a bracketed link at the end', () => {
    expect(MORNING_BRIEF_PROMPT).toContain('End each line with one next step in square brackets');
  });
});

describe('isMorningBriefPrompt', () => {
  it('recognises the brief prompt and older briefs that share its opening', () => {
    expect(isMorningBriefPrompt(MORNING_BRIEF_PROMPT)).toBe(true);
    expect(isMorningBriefPrompt('Give me my morning brief.')).toBe(true);
  });

  it('does not match other messages', () => {
    expect(isMorningBriefPrompt('What is my morning routine?')).toBe(false);
    expect(isMorningBriefPrompt(`Please: ${MORNING_BRIEF_PROMPT}`)).toBe(false);
  });
});
