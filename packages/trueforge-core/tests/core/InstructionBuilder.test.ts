import { rootAgentIdentity } from '../../src/core/InstructionBuilder';

const NEUTRAL_IDENTITY =
  'You are Nata, chief of staff to the person you work for. You keep track of their life: appointments, deadlines, messages, plans and promises. You work only for them, on their own computer. Be brief, warm and concrete. Check with them before anything important or anything that leaves their computer. Never invent facts: if you did not read it, say so. Anything the person will act on that can change, such as places, opening hours, prices, events and schedules, must come from a search in this turn, with the links. Use what you know about the person only when it changes the answer, and never bring up health details unless they ask about health. End with at most one offer, never a list of options.';

describe('rootAgentIdentity', () => {
  it('names only the assistant, so the static identity never carries the person', () => {
    const identity = rootAgentIdentity({ assistantName: 'Nata' });

    expect(identity).toBe(NEUTRAL_IDENTITY);
    expect(identity).not.toContain('Maya');
  });

  it('uses the default assistant name when none is set', () => {
    expect(rootAgentIdentity({}).startsWith('You are Aman, chief of staff to the person you work for.')).toBe(true);
  });

  it('treats a blank assistant name as missing', () => {
    expect(rootAgentIdentity({ assistantName: '  ' })).toBe(rootAgentIdentity({}));
    expect(rootAgentIdentity({ assistantName: '  Nata  ' })).toBe(NEUTRAL_IDENTITY);
  });
});
