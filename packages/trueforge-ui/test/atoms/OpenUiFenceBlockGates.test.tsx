// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXTERNAL_URL_TRUST_STORAGE_KEY, clearSessionImageTrust } from '@/atoms/externalUrlTrust.js';
import { Markdown } from '@/atoms/Markdown.js';
import { OpenUiFenceBlock } from '@/atoms/OpenUiFenceBlock.js';
import { ChatImageScope, ChatTurnWithoutImages } from '@/chatImages/chatImageScope.js';
import type {
  ChatImagesCatalog,
  TurnImagesResult,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/chatImagesCatalog.js';

// The shared setup stubs OpenUI; these tests need the real parser and component library,
// so the gate they assert is the one the shipped fence rendering actually applies.
vi.unmock('@openuidev/react-lang');
vi.unmock('@openuidev/react-ui');

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(EXTERNAL_URL_TRUST_STORAGE_KEY);
  clearSessionImageTrust();
  vi.restoreAllMocks();
});

const REMOTE = 'https://evil.example/p.png?d=secret';

function remoteImg(container: HTMLElement): Element | null {
  return container.querySelector(`img[src^="https://evil.example"]`);
}

function styledWithRemoteUrl(container: HTMLElement): boolean {
  return [...container.querySelectorAll('[style]')].some(el =>
    (el.getAttribute('style') ?? '').includes('evil.example'),
  );
}

describe('OpenUiFenceBlock image and link gates', () => {
  it('shows the click-to-load placeholder for an Image with a remote address, never a live img', () => {
    const { container } = render(
      <OpenUiFenceBlock content={`root = Stack([pic])\npic = Image("sales chart", "${REMOTE}")`} />,
    );

    expect(screen.getByTestId('aui-remote-image-placeholder')).toBeInTheDocument();
    expect(screen.getByTestId('aui-remote-image-placeholder')).toHaveTextContent('evil.example');
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(remoteImg(container)).toBeNull();
  });

  it('gates an ImageBlock address the same way, with no CSS background carrying it', () => {
    const { container } = render(
      <OpenUiFenceBlock
        content={'root = Stack([pic])\npic = ImageBlock("https://evil.example/block.png", "block pic")'}
      />,
    );

    expect(screen.getByTestId('aui-remote-image-placeholder')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(styledWithRemoteUrl(container)).toBe(false);
  });

  it('gates every ImageGallery entry', () => {
    const { container } = render(
      <OpenUiFenceBlock
        content={
          'root = Stack([gal])\n' +
          'gal = ImageGallery([{src: "https://evil.example/a.png", alt: "first"}, {src: "https://evil.example/b.png", alt: "second"}])'
        }
      />,
    );

    expect(screen.getAllByTestId('aui-remote-image-placeholder')).toHaveLength(2);
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(remoteImg(container)).toBeNull();
  });

  it('still renders a data: image inline, as ordinary markdown does', () => {
    const { container } = render(
      <OpenUiFenceBlock content={'root = Stack([pic])\npic = Image("dot", "data:image/png;base64,iVBORw0KGgo=")'} />,
    );

    const img = container.querySelector('img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=');
    expect(screen.queryByTestId('aui-remote-image-placeholder')).not.toBeInTheDocument();
  });

  it('gates an image inside MarkDownRenderer text', () => {
    const { container } = render(
      <OpenUiFenceBlock
        content={'root = Stack([note])\nnote = MarkDownRenderer("![chart](https://evil.example/p.png)")'}
      />,
    );

    expect(screen.getByTestId('aui-remote-image-placeholder')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(remoteImg(container)).toBeNull();
  });

  it('gates an image inside TextContent text', () => {
    const { container } = render(
      <OpenUiFenceBlock content={'root = Stack([note])\nnote = TextContent("![chart](https://evil.example/p.png)")'} />,
    );

    expect(screen.getByTestId('aui-remote-image-placeholder')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(remoteImg(container)).toBeNull();
  });

  it('gates an image inside a Callout description', () => {
    const { container } = render(
      <OpenUiFenceBlock
        content={'root = Stack([note])\nnote = Callout("info", "Heads up", "![chart](https://evil.example/p.png)")'}
      />,
    );

    expect(screen.getByTestId('aui-remote-image-placeholder')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(remoteImg(container)).toBeNull();
  });

  it('gates an image inside a Steps item detail', () => {
    const { container } = render(
      <OpenUiFenceBlock
        content={'root = Stack([guide])\nguide = Steps([StepsItem("First", "![chart](https://evil.example/p.png)")])'}
      />,
    );

    expect(screen.getByTestId('aui-remote-image-placeholder')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(remoteImg(container)).toBeNull();
  });

  it('sends a link inside MarkDownRenderer text through the external-link confirm', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    render(
      <OpenUiFenceBlock
        content={'root = Stack([note])\nnote = MarkDownRenderer("See [docs](https://example.com/docs) for details.")'}
      />,
    );

    const link = screen.getByRole('link', { name: 'docs' });
    // Unapproved external destinations stay off href so middle-click / context-menu cannot bypass.
    expect(link).toHaveAttribute('href', '#');
    expect(link).toHaveAttribute('target', '_blank');

    fireEvent.click(link);
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Open external link' })).toBeInTheDocument();
    expect(screen.getByTestId('aui-external-url-confirm-url')).toHaveTextContent('https://example.com/docs');

    fireEvent.click(screen.getByRole('button', { name: 'Open link' }));
    expect(openSpy).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
  });

  it('keeps a fence image hidden in a chat turn until the person asks, like a markdown image', async () => {
    const showTurnImages = vi.fn(
      (_input: Parameters<ChatImagesCatalog['showTurnImages']>[0]): Promise<TurnImagesResult> =>
        Promise.resolve({ status: 'ask', count: 1, host: 'evil.example', url: 'https://evil.example/p.png' }),
    );
    const port: ChatImagesCatalog = {
      listTurnImages: vi.fn(() => Promise.resolve({ artifacts: [], tool_images: [], emails: [] })),
      showTurnImages,
      imageUrl: ({ sessionId, imageId }) => `/api/chat-images/sessions/${sessionId}/images/${imageId}`,
    };
    const { container } = render(
      <ChatImageScope port={port} sessionId="s1" turnId="t-fence-gate" settled>
        <Markdown
          content={'```openui\nroot = Stack([pic])\npic = Image("sales chart", "https://evil.example/p.png")\n```'}
        />
      </ChatImageScope>,
    );

    expect(await screen.findByText('Image from evil.example hidden')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show image' })).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(showTurnImages).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'reply', url: 'https://evil.example/p.png' }, approved: false }),
    );
  });

  it('does not render a data: image inside a chat turn, matching the markdown treatment', () => {
    const { container } = render(
      <ChatTurnWithoutImages>
        <OpenUiFenceBlock content={'root = Stack([pic])\npic = Image("dot", "data:image/png;base64,iVBORw0KGgo=")'} />
      </ChatTurnWithoutImages>,
    );

    expect(screen.getByTestId('aui-chat-image-not-shown')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });
});
