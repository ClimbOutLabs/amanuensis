import { describe, expect, it } from 'vitest';

import { railMenuRowClassName } from '@/atoms/lib/buttonClasses.js';

describe('railMenuRowClassName', () => {
  it('sizes every menu row (the sidebar More menu, the chat header menu, and the other rows that share it) on the --text-sm step', () => {
    expect(railMenuRowClassName).toContain('text-sm');
    expect(railMenuRowClassName).not.toMatch(/text-\[0\.875rem\]/);
  });
});
