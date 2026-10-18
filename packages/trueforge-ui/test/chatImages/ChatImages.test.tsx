// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Markdown } from '@/atoms/Markdown.js';
import { TurnImages } from '@/chatImages/ChatImages.js';
import { ChatImageScope } from '@/chatImages/chatImageScope.js';
import { CHAT_IMAGE_REFUSAL_TEXT } from '@/chatImages/refusalText.js';
import type {
  ChatImagesCatalog,
  TurnImageList,
  TurnImagesResult,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/chatImagesCatalog.js';

const IMAGE_ID = 'a'.repeat(32);
let turnCounter = 0;

function fakePort(options: {
  show?: (input: Parameters<ChatImagesCatalog['showTurnImages']>[0]) => TurnImagesResult;
  list?: TurnImageList;
}) {
  const showTurnImages = vi.fn((input: Parameters<ChatImagesCatalog['showTurnImages']>[0]) =>
    Promise.resolve(options.show?.(input) ?? { status: 'done' as const, images: [] }),
  );
  const port: ChatImagesCatalog = {
    listTurnImages: vi.fn(() => Promise.resolve(options.list ?? { artifacts: [], emails: [] })),
    showTurnImages,
    imageUrl: ({ sessionId, imageId }) => `/api/chat-images/sessions/${sessionId}/images/${imageId}`,
  };
  return { port, showTurnImages };
}

function renderInScope(input: { port: ChatImagesCatalog; content?: string; settled?: boolean; turnImages?: boolean }) {
  // A fresh turn id per test keeps the shared request cache from leaking between tests.
  turnCounter += 1;
  return render(
    <ChatImageScope port={input.port} sessionId="s1" turnId={`t${String(turnCounter)}`} settled={input.settled ?? true}>
      {input.content !== undefined && <Markdown content={input.content} />}
      {input.turnImages === true && <TurnImages />}
    </ChatImageScope>,
  );
}

const shownImage = { status: 'shown' as const, image_id: IMAGE_ID, width: 4, height: 3 };
const shown = { status: 'done' as const, images: [shownImage] };

function remoteImgCount(container: HTMLElement): number {
  return [...container.querySelectorAll('img')].filter(img => /^https?:/.test(img.getAttribute('src') ?? '')).length;
}

describe('reply images in a chat turn', () => {
  it('loads a silent image as its re-encoded copy, never the link itself', async () => {
    const { port, showTurnImages } = fakePort({ show: () => shown });
    const { container } = renderInScope({ port, content: '![Harbor at dusk](https://example.com/harbor.png)' });
    const img = await screen.findByRole('img', { name: 'Harbor at dusk' });
    expect(img).toHaveAttribute('src', `/api/chat-images/sessions/s1/images/${IMAGE_ID}`);
    expect(showTurnImages).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'reply', url: 'https://example.com/harbor.png' }, approved: false }),
    );
    expect(remoteImgCount(container)).toBe(0);
  });

  it('asks with a card in plain words, and loads only after Show image', async () => {
    const { port, showTurnImages } = fakePort({
      show: input => (input.approved ? shown : { status: 'ask', count: 1, host: 'example.org' }),
    });
    const { container } = renderInScope({ port, content: '![chart](https://example.org/chart.png)' });
    expect(await screen.findByText('Show this image from example.org?')).toBeInTheDocument();
    expect(screen.getByText('That site will see that you looked at it.')).toBeInTheDocument();
    expect(remoteImgCount(container)).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Show image' }));
    expect(await screen.findByRole('img', { name: 'chart' })).toHaveAttribute(
      'src',
      `/api/chat-images/sessions/s1/images/${IMAGE_ID}`,
    );
    expect(showTurnImages).toHaveBeenLastCalledWith(expect.objectContaining({ approved: true }));
  });

  it('keeps the image hidden after Not now', async () => {
    const { port } = fakePort({ show: () => ({ status: 'ask', count: 1, host: 'example.org' }) });
    renderInScope({ port, content: '![chart](https://example.org/chart.png)' });
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.getByTestId('aui-chat-image-not-shown')).toHaveTextContent('chart (image not shown)');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('waits for the turn to finish before asking the server', () => {
    const { port, showTurnImages } = fakePort({ show: () => shown });
    renderInScope({ port, content: '![x](https://example.com/x.png)', settled: false });
    expect(showTurnImages).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('does not render inline data images or other sources the model wrote', () => {
    const { port, showTurnImages } = fakePort({});
    renderInScope({ port, content: '![pixel](data:image/png;base64,AAAA) ![svg](/static/logo.svg)' });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('aui-chat-image-not-shown')).toHaveLength(2);
    expect(showTurnImages).not.toHaveBeenCalled();
  });

  it('shows alt text as plain text, never as HTML', async () => {
    const { port } = fakePort({ show: () => ({ status: 'ask', count: 1, host: 'example.org' }) });
    const { container } = renderInScope({ port, content: '![<b>Bold</b> &lt;i&gt;](https://example.org/a.png)' });
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('i')).toBeNull();
  });

  it('says what went wrong and what to do when an image is refused', async () => {
    const { port } = fakePort({
      show: () => ({ status: 'done', images: [{ status: 'refused', reason: 'sandbox_unavailable' }] }),
    });
    renderInScope({ port, content: '![x](https://example.com/x.png)' });
    expect(await screen.findByTestId('aui-chat-image-refused')).toHaveTextContent(
      'Image checks need the sandbox, which is off. Open Settings → Sandbox to turn it on.',
    );
  });
});

describe('refusal wording', () => {
  it('gives every refusal two short sentences: the problem and the one thing to do', () => {
    for (const text of Object.values(CHAT_IMAGE_REFUSAL_TEXT)) {
      expect(text.split(/(?<=\.)\s/)).toHaveLength(2);
      expect(text).not.toMatch(/—/);
    }
  });
});

describe('turn images', () => {
  it('asks once per email with the exact wording, and shows the images after Show images', async () => {
    const { port, showTurnImages } = fakePort({
      list: { artifacts: [], emails: [{ tool_call_id: 'mail-1', count: 3 }] },
      show: input =>
        input.approved
          ? { status: 'done', images: [shownImage, shownImage, { status: 'refused', reason: 'too_large' }] }
          : { status: 'ask', count: 3, host: null },
    });
    renderInScope({ port, turnImages: true });
    expect(await screen.findByText('Show 3 images from this email?')).toBeInTheDocument();
    expect(screen.getByText("The sender's servers will see that the email was opened.")).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show images' }));
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));
    expect(screen.getByText(CHAT_IMAGE_REFUSAL_TEXT.too_large)).toBeInTheDocument();
    expect(showTurnImages).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: { kind: 'email', tool_call_id: 'mail-1' }, approved: true }),
    );
  });

  it('shows sandbox and tool images without asking', async () => {
    const { port, showTurnImages } = fakePort({
      list: { artifacts: [{ path: 'run_code/chart.png', name: 'chart.png' }], emails: [] },
      show: () => shown,
    });
    renderInScope({ port, turnImages: true });
    expect(await screen.findByRole('img', { name: 'chart.png' })).toBeInTheDocument();
    expect(showTurnImages).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'artifact', path: 'run_code/chart.png' }, approved: false }),
    );
  });
});

describe('outside a chat turn', () => {
  it('keeps the existing Markdown image rules', () => {
    render(<Markdown content="![alt text](https://example.com/pic.png)" />);
    expect(screen.getByTestId('aui-remote-image-placeholder')).toBeInTheDocument();
  });
});
