import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';

import { MessageGroup, ThreadComposerAreaShell, ThreadRootShell, ThreadViewportShell } from '@/atoms/ThreadShell.js';

describe('ThreadRootShell', () => {
  it('merges host styles over defaults and forwards its ref and attributes', () => {
    const ref = createRef<HTMLDivElement>();
    const hostStyle = Object.assign({ color: 'red' }, { '--prose-max-width': '40rem' });
    render(<ThreadRootShell ref={ref} data-testid="thread-root" className="host-thread" style={hostStyle} />);

    const root = screen.getByTestId('thread-root');
    expect(root).toBe(ref.current);
    expect(root).toHaveClass('aui-thread-root', 'host-thread');
    expect(root.style.getPropertyValue('--prose-max-width')).toBe('40rem');
    // Composer surface uses --input-box-bg on the theme root; thread shell must not set --composer-bg.
    expect(root.style.getPropertyValue('--composer-bg')).toBe('');
    expect(root.style.color).toBe('red');
  });

  it('leaves the reading measure to the stylesheet, so every chat surface shares it', () => {
    render(<ThreadRootShell data-testid="thread-root" />);

    expect(screen.getByTestId('thread-root').style.getPropertyValue('--prose-max-width')).toBe('');
  });
});

describe('the message list and composer share the thread column', () => {
  it('both fill the column the layout gives them, so they line up with each other', () => {
    render(
      <ThreadViewportShell data-testid="viewport">
        <p>Messages</p>
      </ThreadViewportShell>,
    );
    render(<ThreadComposerAreaShell data-testid="composer">Composer</ThreadComposerAreaShell>);

    const viewportColumn = screen.getByTestId('viewport').firstElementChild;
    const composer = screen.getByTestId('composer');
    expect(viewportColumn).toHaveClass('w-full', 'mx-auto');
    expect(viewportColumn?.className ?? '').not.toMatch(/max-w-/);
    expect(composer).toHaveClass('w-full', 'mx-auto');
    expect(composer.className).not.toMatch(/max-w-/);
  });
});

describe('ThreadViewportShell', () => {
  it('centers empty content and restores message-list spacing when populated', () => {
    const { rerender } = render(
      <ThreadViewportShell isEmpty data-testid="viewport">
        <p>Welcome</p>
      </ThreadViewportShell>,
    );

    const viewport = screen.getByTestId('viewport');
    expect(viewport).toHaveAttribute('data-slot', 'aui_thread-viewport');
    // CSS smooth scroll fights assistant-ui autoScroll and causes bounce on large streams.
    expect(viewport.className).not.toMatch(/\bscroll-smooth\b/);
    expect(viewport.firstElementChild).toHaveClass('min-h-full', 'justify-center', 'pb-4');
    expect(viewport).toHaveTextContent('Welcome');

    rerender(
      <ThreadViewportShell isEmpty={false} data-testid="viewport">
        <p>Messages</p>
      </ThreadViewportShell>,
    );
    expect(viewport.firstElementChild).toHaveClass('pb-24');
    expect(viewport.firstElementChild).not.toHaveClass('justify-center');
  });
});

describe('ThreadComposerAreaShell', () => {
  it('applies populated-state rounding while forwarding content and attributes', () => {
    const { rerender } = render(
      <ThreadComposerAreaShell isEmpty data-testid="composer" className="host-composer">
        Empty composer
      </ThreadComposerAreaShell>,
    );

    const composer = screen.getByTestId('composer');
    expect(composer).toHaveAttribute('data-slot', 'aui_thread-composer');
    expect(composer).toHaveClass('host-composer');
    expect(composer).not.toHaveClass('rounded-t-(--composer-radius)');

    rerender(
      <ThreadComposerAreaShell isEmpty={false} data-testid="composer">
        Populated composer
      </ThreadComposerAreaShell>,
    );
    // Phones keep the rounded tab; desktop drops it so messages do not look like they sit in a box.
    expect(composer).toHaveClass('rounded-t-(--composer-radius)', 'md:rounded-t-none');
    expect(composer).toHaveTextContent('Populated composer');
  });

  it('sits lower on desktop and fades messages out above the composer, leaving phones unchanged', () => {
    render(<ThreadComposerAreaShell data-testid="composer">Composer</ThreadComposerAreaShell>);

    const composer = screen.getByTestId('composer');
    expect(composer).toHaveClass(
      'pb-[max(1rem,env(safe-area-inset-bottom,0px))]',
      'md:pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]',
      'md:before:absolute',
      'md:before:bottom-full',
      'md:before:h-6',
      'md:before:bg-linear-to-t',
    );
    expect(composer.className).not.toMatch(/md:pb-\[max\(1\.5rem/);
  });
});

describe('MessageGroup', () => {
  it('forwards its ref, children, and host attributes', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <MessageGroup ref={ref} data-testid="message-group" className="host-group">
        <article>Message one</article>
      </MessageGroup>,
    );

    const group = screen.getByTestId('message-group');
    expect(group).toBe(ref.current);
    expect(group).toHaveAttribute('data-slot', 'aui_message-group');
    expect(group).toHaveClass('empty:hidden', 'host-group');
    expect(group).toContainElement(screen.getByText('Message one'));
  });
});
