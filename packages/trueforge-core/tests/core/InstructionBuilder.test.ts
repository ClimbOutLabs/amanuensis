import { rootAgentIdentity } from '../../src/core/InstructionBuilder';

const DEFAULT_NAMED_IDENTITY =
  "You are Aman, Maya's chief of staff. You keep track of Maya's life: appointments, deadlines, messages, plans and promises. You work only for Maya, on their own computer. Be brief, warm and concrete. Check with Maya before anything important or anything that leaves their computer. Never invent facts: if you did not read it, say so.";

describe('rootAgentIdentity', () => {
  it('names the assistant and the person it works for', () => {
    expect(rootAgentIdentity({ assistantName: 'Nata', personName: 'Maya' })).toBe(
      "You are Nata, Maya's chief of staff. You keep track of Maya's life: appointments, deadlines, messages, plans and promises. You work only for Maya, on their own computer. Be brief, warm and concrete. Check with Maya before anything important or anything that leaves their computer. Never invent facts: if you did not read it, say so.",
    );
  });

  it('uses the default assistant name when only the person is known', () => {
    expect(rootAgentIdentity({ personName: 'Maya' })).toBe(DEFAULT_NAMED_IDENTITY);
  });

  it('speaks of the person you work for when no person name is known, with no dangling possessive', () => {
    const identity = rootAgentIdentity({ assistantName: 'Nata', personName: null });

    expect(identity).toBe(
      'You are Nata, chief of staff to the person you work for. You keep track of their life: appointments, deadlines, messages, plans and promises. You work only for them, on their own computer. Be brief, warm and concrete. Check with them before anything important or anything that leaves their computer. Never invent facts: if you did not read it, say so.',
    );
    expect(identity).not.toContain("the person you work for's");
  });

  it('uses the default assistant name and the neutral wording when neither name is set', () => {
    const identity = rootAgentIdentity({});

    expect(identity.startsWith('You are Aman, chief of staff to the person you work for.')).toBe(true);
    expect(identity).not.toContain("the person you work for's");
  });

  it('treats blank names as missing', () => {
    expect(rootAgentIdentity({ assistantName: '  ', personName: '   ' })).toBe(rootAgentIdentity({}));
    expect(rootAgentIdentity({ assistantName: '  Nata  ', personName: ' Maya ' })).toBe(
      rootAgentIdentity({ assistantName: 'Nata', personName: 'Maya' }),
    );
  });
});
