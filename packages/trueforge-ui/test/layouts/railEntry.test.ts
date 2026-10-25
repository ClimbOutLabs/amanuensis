import { railEntryFor } from '@/layouts/railEntry.js';
import type { ShellMode } from '@/server/ShellModeContext.js';
import { describe, expect, it } from 'vitest';

const chat: ShellMode = { status: 'active', isMutable: true, isCreateAgent: false, locked: false };
const closed = {
  settingsOpen: false,
  sessionsOpen: false,
  libraryOpen: false,
  schedulesOpen: false,
  spacesOpen: false,
};

describe('railEntryFor', () => {
  it('lights Chats on a chat, and each rail page when it is open', () => {
    expect(railEntryFor({ ...closed, mode: chat })).toBe('chats');
    expect(railEntryFor({ ...closed, spacesOpen: true, mode: chat })).toBe('spaces');
    expect(railEntryFor({ ...closed, schedulesOpen: true, mode: chat })).toBe('schedules');
  });

  it('lights the parent for pages reached through More', () => {
    expect(railEntryFor({ ...closed, settingsOpen: true, mode: chat })).toBe('more');
    expect(railEntryFor({ ...closed, sessionsOpen: true, mode: chat })).toBe('more');
    expect(railEntryFor({ ...closed, libraryOpen: true, mode: chat })).toBe('more');
    expect(railEntryFor({ ...closed, mode: { ...chat, isCreateAgent: true } })).toBe('more');
  });

  it('lets an open page win over the agent builder underneath it', () => {
    expect(railEntryFor({ ...closed, spacesOpen: true, mode: { ...chat, isCreateAgent: true } })).toBe('spaces');
  });

  it('lights More on the agent library landing page', () => {
    expect(railEntryFor({ ...closed, mode: { status: 'idle' } })).toBe('more');
  });
});
