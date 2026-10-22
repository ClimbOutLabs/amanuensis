import { rootAgentIdentity } from '../../src/core/InstructionBuilder';

const NEUTRAL_IDENTITY =
  'You are Nata, chief of staff to the person you work for. You keep track of their life: appointments, deadlines, messages, plans and promises. You work only for them, on their own computer. Be brief, warm and concrete. Check with them before anything important or anything that leaves their computer. Never invent facts: if you did not read it, say so.';

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
