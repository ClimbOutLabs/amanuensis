// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OpenUiFenceBlock } from '@/atoms/OpenUiFenceBlock.js';

import { malformedBriefingBlock } from '../fixtures/openUiMalformedBriefing.js';

// The shared setup stubs OpenUI; these tests need the real parser and component library.
vi.unmock('@openuidev/react-lang');
vi.unmock('@openuidev/react-ui');

describe('OpenUiFenceBlock with the real renderer', () => {
  it('renders every section of a block with two bracket slips and an undefined $variable', () => {
    const { container } = render(<OpenUiFenceBlock content={malformedBriefingBlock} />);
    const text = container.textContent ?? '';

    for (const heading of ['From', 'Drafts', 'Calendar', 'Travel', 'Briefing', 'Tomorrow', 'Needs your OK']) {
      expect(text).toContain(heading);
    }
    expect(text).toContain('Planning offsite at 10:00.');
    expect(text).not.toContain('root = Stack');
    expect(text).not.toContain('Stack[');
    expect(text).not.toContain('$showImportant');
  });

  it('shows no raw source when the root cannot be built', () => {
    const { container } = render(<OpenUiFenceBlock content={'root = Stack[a, b\na = TextContent("hi")'} />);

    expect(container.textContent).not.toContain('root =');
    expect(container.textContent).not.toContain('hi');
  });
});
