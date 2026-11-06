// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { FolderSection } from '@/containers/FolderControls.js';

beforeEach(() => {
  window.localStorage.clear();
});

function parentOf(element: HTMLElement): HTMLElement {
  const parent = element.parentElement;
  if (parent === null) throw new Error('Expected the element to have a parent');
  return parent;
}

describe('FolderSection indentation', () => {
  it('indents the spaces in a folder one step in from the folder row', () => {
    render(
      <FolderSection kind="space" folder={{ id: 'folder-a', name: 'Briefings' }} count={1} operations={null}>
        <div data-testid="space-card">Morning Brief</div>
      </FolderSection>,
    );

    const wrapper = parentOf(screen.getByTestId('space-card'));
    expect(wrapper.classList.contains('pl-8')).toBe(true);
    expect(wrapper.classList.contains('pl-2')).toBe(false);

    // The folder row itself keeps its place at the list edge.
    const headerRow = parentOf(screen.getByRole('button', { name: /Briefings/ }));
    expect(headerRow.classList.contains('pl-8')).toBe(false);
  });

  it('indents the chats in a folder by the same step', () => {
    render(
      <FolderSection kind="chat" folder={{ id: 'folder-a', name: 'Projects' }} count={1} operations={null}>
        <div data-testid="chat-row">Quarterly plan</div>
      </FolderSection>,
    );

    const wrapper = parentOf(screen.getByTestId('chat-row'));
    expect(wrapper.classList.contains('pl-8')).toBe(true);
    expect(wrapper.classList.contains('pl-2')).toBe(false);
  });

  it('indents a folder inside a folder one more step, so each level adds its own', () => {
    render(
      <FolderSection kind="space" folder={{ id: 'folder-a', name: 'Outer' }} count={1} operations={null}>
        <FolderSection kind="space" folder={{ id: 'folder-b', name: 'Inner' }} count={1} operations={null}>
          <div data-testid="nested-card">Nested page</div>
        </FolderSection>
      </FolderSection>,
    );

    // The inner folder section sits inside the outer folder's indented children...
    const innerSection = screen.getByText('Nested page').closest('section');
    if (innerSection === null) throw new Error('Expected the nested card to sit in a section');
    expect(parentOf(innerSection).classList.contains('pl-8')).toBe(true);
    // ...and the inner folder's own children take the same step again from there.
    expect(parentOf(screen.getByTestId('nested-card')).classList.contains('pl-8')).toBe(true);
  });
});
