import { describe, expect, it } from 'vitest';

import { agentNameFromLabel } from '@/atoms/lib/agentName.js';

describe('agentNameFromLabel', () => {
  it('turns an everyday name into lowercase words joined by hyphens', () => {
    expect(agentNameFromLabel('Morning Email Helper')).toBe('morning-email-helper');
    expect(agentNameFromLabel("  Sidd's  trip planner! ")).toBe('sidd-s-trip-planner');
  });

  it('leaves a name that is already in the saved form alone', () => {
    expect(agentNameFromLabel('release-notes')).toBe('release-notes');
  });

  it('starts with a letter and never ends on a hyphen', () => {
    expect(agentNameFromLabel('2nd brain')).toBe('nd-brain');
    expect(agentNameFromLabel(`a${'b'.repeat(62)} c`)).toBe(`a${'b'.repeat(62)}`);
  });

  it('gives nothing back when no letters are left', () => {
    expect(agentNameFromLabel('123 !!')).toBe('');
    expect(agentNameFromLabel('   ')).toBe('');
  });
});
