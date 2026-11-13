import { describe, expect, it } from 'vitest';

import { headerActionClassName, railMenuRowClassName, sidebarRailButtonClassName } from '@/atoms/lib/buttonClasses.js';

describe('railMenuRowClassName', () => {
  it('sizes every menu row (the sidebar More menu, the chat header menu, and the other rows that share it) on the --text-sm step', () => {
    expect(railMenuRowClassName).toContain('text-sm');
    expect(railMenuRowClassName).not.toMatch(/text-\[0\.875rem\]/);
  });
});

describe('sidebarRailButtonClassName', () => {
  it('sizes the rail nav labels (Chats, Spaces, Schedules, More) on the --text-xs step, not a one-off literal', () => {
    expect(sidebarRailButtonClassName).toContain('text-xs');
    expect(sidebarRailButtonClassName).not.toMatch(/text-\[0\.75rem\]/);
  });
});

describe('headerActionClassName', () => {
  it('sizes every chat header action on the --text-sm step, not a one-off literal', () => {
    expect(headerActionClassName).toContain('text-sm');
    expect(headerActionClassName).not.toMatch(/text-\[0\.8125rem\]/);
  });
});
