// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Markdown } from '@/atoms/Markdown.js';
import { TurnImages } from '@/chatImages/ChatImages.js';
import { ChatImageScope } from '@/chatImages/chatImageScope.js';
import { CHAT_IMAGE_ERROR_TEXT, CHAT_IMAGE_REFUSAL_TEXT, EMAIL_IMAGES_ERROR_TEXT } from '@/chatImages/refusalText.js';
import type {
  ChatImagesCatalog,
  TurnImageList,
  TurnImagesResult,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/chatImagesCatalog.js';
import { createChatImagesCatalog } from '@/plugins/trueforge-agent-server-adapter/catalogs/chatImagesCatalog.js';

const IMAGE_ID = 'a'.repeat(32);
const IMAGE_SRC = `/api/chat-images/sessions/s1/images/${IMAGE_ID}`;
let turnCounter = 0;

function fakePort(options: {
  show?: (input: Parameters<ChatImagesCatalog['showTurnImages']>[0]) => TurnImagesResult;
  list?: TurnImageList;
}) {
  const showTurnImages = vi.fn((input: Parameters<ChatImagesCatalog['showTurnImages']>[0]) =>
    Promise.resolve(options.show?.(input) ?? { status: 'done' as const, images: [] }),
  );
  const port: ChatImagesCatalog = {
    listTurnImages: vi.fn(() => Promise.resolve(options.list ?? { artifacts: [], tool_images: [], emails: [] })),
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
  it('never loads a web image in a reply until the person asks', async () => {
    const { port, showTurnImages } = fakePort({ show: () => ({ status: 'ask', count: 1, host: 'example.com' }) });
    const { container } = renderInScope({ port, content: '![Harbor at dusk](https://example.com/harbor.png)' });
    expect(await screen.findByText('Image from example.com hidden')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show image' })).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(remoteImgCount(container)).toBe(0);
    expect(showTurnImages).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'reply', url: 'https://example.com/harbor.png' }, approved: false }),
    );
    expect(showTurnImages).not.toHaveBeenCalledWith(expect.objectContaining({ approved: true }));
  });

  it('loads the re-encoded copy only after Show image, never the link itself', async () => {
    const { port, showTurnImages } = fakePort({
      show: input => (input.approved ? shown : { status: 'ask', count: 1, host: 'example.org' }),
    });
    const { container } = renderInScope({ port, content: '![chart](https://example.org/chart.png)' });
    fireEvent.click(await screen.findByRole('button', { name: 'Show image' }));
    expect(await screen.findByRole('img', { name: 'chart' })).toHaveAttribute('src', IMAGE_SRC);
    expect(showTurnImages).toHaveBeenLastCalledWith(expect.objectContaining({ approved: true }));
    expect(remoteImgCount(container)).toBe(0);
  });

  it('shows an image the person already approved in this chat without asking again', async () => {
    const { port, showTurnImages } = fakePort({ show: () => shown });
    renderInScope({ port, content: '![Harbor at dusk](https://example.com/harbor.png)' });
    expect(await screen.findByRole('img', { name: 'Harbor at dusk' })).toHaveAttribute('src', IMAGE_SRC);
    expect(screen.queryByRole('button', { name: 'Show image' })).not.toBeInTheDocument();
    expect(showTurnImages).toHaveBeenCalledTimes(1);
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
    const { port } = fakePort({ show: () => shown });
    const { container } = renderInScope({ port, content: '![<b>Bold</b> &lt;i&gt;](https://example.org/a.png)' });
    expect((await screen.findByRole('img')).getAttribute('alt')).toContain('<b>Bold</b>');
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

describe('thumbnails', () => {
  it('shows each image as a 10rem thumbnail that opens the full image in a new tab', async () => {
    const { port } = fakePort({
      list: { artifacts: [{ path: 'run_code/chart.png', name: 'chart.png' }], tool_images: [], emails: [] },
      show: () => shown,
    });
    renderInScope({ port, turnImages: true });
    const img = await screen.findByRole('img', { name: 'chart.png' });
    expect(img).toHaveClass('w-40', 'h-auto');
    expect(img).not.toHaveClass('max-h-[24rem]');
    const link = img.closest('a');
    expect(link).toHaveAttribute('href', IMAGE_SRC);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('puts several images in one row of thumbnails, not a stack', async () => {
    const { port } = fakePort({
      list: {
        artifacts: [
          { path: 'run_code/a.png', name: 'a.png' },
          { path: 'run_code/b.png', name: 'b.png' },
        ],
        tool_images: [],
        emails: [],
      },
      show: () => shown,
    });
    renderInScope({ port, turnImages: true });
    const first = await screen.findByRole('img', { name: 'a.png' });
    const second = await screen.findByRole('img', { name: 'b.png' });
    expect(first.closest('a')?.parentElement).toBe(second.closest('a')?.parentElement);
    expect(first.closest('a')?.parentElement).toHaveClass('flex-wrap');
  });

  it('leaves nothing behind when an image fails to load', async () => {
    const { port } = fakePort({
      list: {
        artifacts: [
          { path: 'run_code/a.png', name: 'a.png' },
          { path: 'run_code/b.png', name: 'b.png' },
        ],
        tool_images: [],
        emails: [],
      },
      show: () => shown,
    });
    const { container } = renderInScope({ port, turnImages: true });
    fireEvent.error(await screen.findByRole('img', { name: 'a.png' }));
    expect(screen.queryByRole('img', { name: 'a.png' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'b.png' })).toBeInTheDocument();
    fireEvent.error(screen.getByRole('img', { name: 'b.png' }));
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('leaves no empty box for a reply image that fails to load', async () => {
    const { port } = fakePort({ show: () => shown });
    const { container } = renderInScope({ port, content: '![Gone](https://example.com/gone.png)' });
    fireEvent.error(await screen.findByRole('img', { name: 'Gone' }));
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });
});

describe('turn images', () => {
  it('shows one quiet line for every email image and asks the server nothing until Load images', async () => {
    const { port, showTurnImages } = fakePort({
      list: {
        artifacts: [],
        tool_images: [],
        emails: [
          { tool_call_id: 'mail-1', count: 3 },
          { tool_call_id: 'mail-2', count: 2 },
        ],
      },
      show: input =>
        input.approved
          ? { status: 'done', images: [shownImage, { status: 'refused', reason: 'too_large' }] }
          : { status: 'ask', count: 2, host: null },
    });
    renderInScope({ port, turnImages: true });
    expect(await screen.findByText('5 images from your emails were not loaded.')).toBeInTheDocument();
    expect(screen.getAllByTestId('aui-email-images-hidden')).toHaveLength(1);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(showTurnImages).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Load images' }));
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));
    // Two refusals, one sentence pair.
    expect(screen.getAllByTestId('aui-chat-image-refused')).toHaveLength(1);
    expect(screen.getByText(CHAT_IMAGE_REFUSAL_TEXT.too_large)).toBeInTheDocument();
    expect(showTurnImages).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'email', tool_call_id: 'mail-1' }, approved: true }),
    );
    expect(showTurnImages).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'email', tool_call_id: 'mail-2' }, approved: true }),
    );
  });

  it('names one email in the singular', async () => {
    const { port } = fakePort({
      list: { artifacts: [], tool_images: [], emails: [{ tool_call_id: 'mail-1', count: 1 }] },
    });
    renderInScope({ port, turnImages: true });
    expect(await screen.findByText('1 image from the email was not loaded.')).toBeInTheDocument();
  });

  it('says what happened and offers Try again when the chosen images cannot be loaded', async () => {
    const showTurnImages = vi.fn(() => Promise.reject(new Error('offline')));
    const port: ChatImagesCatalog = {
      listTurnImages: () =>
        Promise.resolve({ artifacts: [], tool_images: [], emails: [{ tool_call_id: 'mail-1', count: 4 }] }),
      showTurnImages,
      imageUrl: ({ sessionId, imageId }) => `/api/chat-images/sessions/${sessionId}/images/${imageId}`,
    };
    renderInScope({ port, turnImages: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Load images' }));
    expect(await screen.findByText(EMAIL_IMAGES_ERROR_TEXT)).toBeInTheDocument();
    expect(screen.getAllByTestId('aui-email-images-error')).toHaveLength(1);
    expect(screen.queryByText(CHAT_IMAGE_ERROR_TEXT)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(showTurnImages).toHaveBeenCalledTimes(2));
  });

  it('shows sandbox images such as charts without asking', async () => {
    const { port, showTurnImages } = fakePort({
      list: { artifacts: [{ path: 'run_code/chart.png', name: 'chart.png' }], tool_images: [], emails: [] },
      show: () => shown,
    });
    renderInScope({ port, turnImages: true });
    expect(await screen.findByRole('img', { name: 'chart.png' })).toBeInTheDocument();
    expect(showTurnImages).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'artifact', path: 'run_code/chart.png' }, approved: false }),
    );
  });

  it('keeps images a tool returned hidden until the person asks for them', async () => {
    const { port, showTurnImages } = fakePort({
      list: {
        artifacts: [],
        tool_images: [{ path: 'tool_images/call-1/image-1.png', name: 'image-1.png' }],
        emails: [],
      },
      show: () => shown,
    });
    renderInScope({ port, turnImages: true });
    expect(await screen.findByText('Image hidden')).toBeInTheDocument();
    expect(showTurnImages).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show image' }));
    expect(await screen.findByRole('img', { name: 'image-1.png' })).toBeInTheDocument();
    expect(showTurnImages).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'artifact', path: 'tool_images/call-1/image-1.png' } }),
    );
  });
});

describe('outside a chat turn', () => {
  it('keeps the existing Markdown image rules', () => {
    render(<Markdown content="![alt text](https://example.com/pic.png)" />);
    expect(screen.getByTestId('aui-remote-image-placeholder')).toBeInTheDocument();
  });
});

describe('an answer that copied images from the emails it read', () => {
  const emailImages = Array.from({ length: 8 }, (_, i) => `https://news.example.com/art/${String(i)}.png`);
  const tracker = 'https://u1.ct.sendgrid.net/wf/open?upn=xyz';
  const asked = 'https://example.org/requested-chart.png';

  /** Answers like the real routes: copied email images and trackers come back empty, other links ask. */
  function serverFetch() {
    const requests: string[] = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (init?.method !== 'POST') {
        return Promise.resolve(
          Response.json({ data: { artifacts: [], tool_images: [], emails: [{ tool_call_id: 'mail-1', count: 8 }] } }),
        );
      }
      const body: unknown = JSON.parse(String(init.body));
      const link =
        typeof body === 'object' && body !== null && 'source' in body && typeof body.source === 'object'
          ? Reflect.get(body.source ?? {}, 'url')
          : undefined;
      return Promise.resolve(
        Response.json({
          data: link === asked ? { status: 'ask', count: 1, host: 'example.org' } : { status: 'done', images: [] },
        }),
      );
    });
    return { fetchImpl, requests };
  }

  it('makes no request off the page, shows no box per image, and keeps one quiet line', async () => {
    const { fetchImpl, requests } = serverFetch();
    const port = createChatImagesCatalog({ fetch: fetchImpl });
    const content = [
      'Here is your morning brief.',
      ...emailImages.map(url => `![newsletter art](${url})`),
      `<img src="${tracker}" width="1" height="1">`,
    ].join('\n\n');
    const { container } = renderInScope({ port, content, turnImages: true });
    expect(await screen.findByText('8 images from the email were not loaded.')).toBeInTheDocument();
    await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(10));
    expect(requests.every(url => url.startsWith('/api/chat-images/'))).toBe(true);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(remoteImgCount(container)).toBe(0);
    expect(screen.queryByTestId('aui-chat-image-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('aui-chat-image-not-shown')).not.toBeInTheDocument();
    expect(screen.queryByTestId('aui-chat-image-error')).not.toBeInTheDocument();
    expect(screen.queryByText(CHAT_IMAGE_ERROR_TEXT)).not.toBeInTheDocument();
    expect(screen.getAllByTestId('aui-email-images-hidden')).toHaveLength(1);
  });

  it('still offers an image the person asked for', async () => {
    const { fetchImpl } = serverFetch();
    const port = createChatImagesCatalog({ fetch: fetchImpl });
    const content = [`![the chart you asked for](${asked})`, ...emailImages.map(url => `![art](${url})`)].join('\n\n');
    renderInScope({ port, content, turnImages: true });
    expect(await screen.findByText('Image from example.org hidden')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Show image' })).toHaveLength(1);
  });
});
