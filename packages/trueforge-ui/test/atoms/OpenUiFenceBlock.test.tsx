// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { OpenUiFenceBlock } from '@/atoms/OpenUiFenceBlock.js';

const openUiMocks = vi.hoisted(() => {
  const definition = (name: string) => ({ name, props: {}, description: `${name} description`, component: () => null });
  return {
    definitions: {
      Stack: definition('Stack'),
      Card: definition('Card'),
      Image: definition('Image'),
      ImageBlock: definition('ImageBlock'),
      ImageGallery: definition('ImageGallery'),
      MarkDownRenderer: definition('MarkDownRenderer'),
      TextContent: definition('TextContent'),
      Callout: definition('Callout'),
      Steps: definition('Steps'),
    },
    renderer: vi.fn(),
  };
});

vi.mock('@openuidev/react-lang', () => ({
  Renderer: ({ response, library, isStreaming }: { response: string; library: unknown; isStreaming?: boolean }) => {
    openUiMocks.renderer({ response, library, isStreaming });
    return (
      <div data-testid="openui-renderer" data-streaming={String(Boolean(isStreaming))}>
        {response}
      </div>
    );
  },
  createLibrary: (input: { root?: string; componentGroups?: unknown; components: Array<{ name: string }> }) => ({
    root: input.root,
    componentGroups: input.componentGroups,
    components: Object.fromEntries(input.components.map(component => [component.name, component])),
  }),
  useStateField: (name: string, value?: unknown) => ({ name, value, isReactive: false, setValue: () => {} }),
  useTriggerAction: () => () => {},
}));

vi.mock('@openuidev/react-ui', () => ({
  ThemeProvider: ({ mode, children }: { mode: string; children: ReactNode }) => (
    <div data-testid="openui-theme" data-mode={mode}>
      {children}
    </div>
  ),
  Callout: () => null,
  Steps: ({ children }: { children?: ReactNode }) => children,
  StepsItem: () => null,
  openuiLibrary: {
    root: 'Stack',
    componentGroups: [],
    components: openUiMocks.definitions,
  },
}));

type RenderedLibrary = {
  root?: string;
  components: Record<string, { name: string; props: unknown; description: string; component: unknown }>;
};

function lastRenderedLibrary(): RenderedLibrary {
  const calls = openUiMocks.renderer.mock.calls;
  const last = calls[calls.length - 1];
  if (last === undefined) {
    throw new Error('the renderer was not called');
  }
  return last[0].library;
}

describe('OpenUiFenceBlock', () => {
  it('passes content, streaming state, and the gated OpenUI library to the renderer', () => {
    render(<OpenUiFenceBlock content='{"type":"Text","text":"Working"}' isStreaming />);

    expect(screen.getByTestId('openui-renderer')).toHaveTextContent('{"type":"Text","text":"Working"}');
    expect(screen.getByTestId('openui-renderer')).toHaveAttribute('data-streaming', 'true');
    expect(openUiMocks.renderer).toHaveBeenCalledWith(
      expect.objectContaining({
        response: '{"type":"Text","text":"Working"}',
        isStreaming: true,
      }),
    );

    // The library keeps the pinned root and every component definition, with the
    // image and markdown carriers swapped for gated renderers that keep the same
    // name, props and description.
    const library = lastRenderedLibrary();
    expect(library.root).toBe('Stack');
    expect(library.components['Card']).toBe(openUiMocks.definitions.Card);
    const gatedNames: Array<keyof typeof openUiMocks.definitions> = [
      'Image',
      'ImageBlock',
      'ImageGallery',
      'MarkDownRenderer',
      'TextContent',
      'Callout',
      'Steps',
    ];
    for (const name of gatedNames) {
      const original = openUiMocks.definitions[name];
      const gated = library.components[name];
      expect(gated?.name).toBe(original.name);
      expect(gated?.props).toBe(original.props);
      expect(gated?.description).toBe(original.description);
      expect(gated?.component).not.toBe(original.component);
    }
  });

  it('selects light and dark OpenUI themes from the public prop', () => {
    const { rerender } = render(<OpenUiFenceBlock content="content" />);
    expect(screen.getByTestId('openui-theme')).toHaveAttribute('data-mode', 'light');

    rerender(<OpenUiFenceBlock content="content" darkTheme />);
    expect(screen.getByTestId('openui-theme')).toHaveAttribute('data-mode', 'dark');
  });
});
