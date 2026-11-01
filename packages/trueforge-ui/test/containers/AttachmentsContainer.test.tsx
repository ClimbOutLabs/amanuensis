// @vitest-environment jsdom
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AttachmentAdapter,
  type PendingAttachment,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { AttachmentPickerButtonProps } from '@/atoms/AttachmentPickerButton.js';
import type { AttachmentPreviewDialogProps } from '@/atoms/AttachmentPreviewDialog.js';
import {
  ComposerAttachmentPickerContainer,
  ComposerAttachmentsContainer,
  MessageAttachmentsContainer,
} from '@/containers/AttachmentsContainer.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { createMockAgentUIServer } from '../server/mockServer.js';
import { RuntimeHarness } from './RuntimeHarness.js';

function sentImageMessage(attachmentId: string): ThreadMessageLike {
  return {
    role: 'user',
    content: 'Please inspect this',
    attachments: [
      {
        id: attachmentId,
        type: 'image',
        name: 'result.png',
        contentType: 'image/png',
        status: { type: 'complete' },
        content: [{ type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=', filename: 'result.png' }],
      },
    ],
  };
}

beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:composer-preview'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

function createAttachmentAdapter(remove: AttachmentAdapter['remove']): AttachmentAdapter {
  return {
    accept: 'image/*,.pdf',
    add: async ({ file }) => ({
      id: `pending-${file.name}`,
      type: file.type.startsWith('image/') ? 'image' : 'file',
      name: file.name,
      contentType: file.type,
      file,
      status: { type: 'requires-action', reason: 'composer-send' },
    }),
    remove,
    send: async (attachment: PendingAttachment) => ({
      ...attachment,
      status: { type: 'complete' },
      content: [
        {
          type: 'file',
          data: 'data:application/octet-stream;base64,AA==',
          mimeType: attachment.contentType ?? 'application/octet-stream',
          filename: attachment.name,
        },
      ],
    }),
  };
}

function AttachmentRuntimeHarness({ adapter, children }: { adapter: AttachmentAdapter; children: ReactNode }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: message => message,
    onNew: async () => {},
    adapters: { attachments: adapter },
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

function PickerOverride(props: AttachmentPickerButtonProps) {
  return (
    <button type="button" {...props}>
      Choose attachment
    </button>
  );
}

function PreviewOverride({ previewSrc, children }: AttachmentPreviewDialogProps) {
  return (
    <div data-testid="attachment-preview-slot" data-preview-src={previewSrc}>
      {children}
    </div>
  );
}

describe('attachment containers', () => {
  it('uses the picker slot, stages a selected file, supplies its preview, and removes it', async () => {
    const remove = vi.fn<AttachmentAdapter['remove']>(async () => {});
    const adapter = createAttachmentAdapter(remove);

    render(
      <SlotsProvider
        overrides={{
          AttachmentPickerButton: PickerOverride,
          AttachmentPreviewDialog: PreviewOverride,
        }}
      >
        <AttachmentRuntimeHarness adapter={adapter}>
          <ComposerAttachmentPickerContainer />
          <ComposerAttachmentsContainer />
        </AttachmentRuntimeHarness>
      </SlotsProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose attachment' }));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    if (input === null) {
      throw new Error('Expected attachment file input');
    }
    expect(input).toHaveAttribute('accept', 'image/*,.pdf');

    const file = new File(['image'], 'diagram.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText('diagram.png')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('attachment-preview-slot')).toHaveAttribute(
        'data-preview-src',
        'blob:composer-preview',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove file' }));

    await waitFor(() => {
      expect(screen.queryByText('diagram.png')).not.toBeInTheDocument();
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[0]).toMatchObject({
      id: 'pending-diagram.png',
      name: 'diagram.png',
      contentType: 'image/png',
    });
  });

  it('never previews the stored original of a sent image', () => {
    render(
      <RuntimeHarness messages={[sentImageMessage('image-1')]}>
        <ThreadPrimitive.Messages>{() => <MessageAttachmentsContainer />}</ThreadPrimitive.Messages>
      </RuntimeHarness>,
    );

    expect(screen.queryByRole('button', { name: 'Remove file' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open attachment preview' })).not.toBeInTheDocument();
    expect(document.querySelector('img[src^="data:"]')).toBeNull();
    expect(screen.getByText('result.png')).toBeInTheDocument();
  });

  it('opens a full-size preview of the re-encoded copy of a sent image', async () => {
    const imageId = 'b'.repeat(32);
    const showTurnImages = vi.fn(() =>
      Promise.resolve({
        status: 'done' as const,
        images: [{ status: 'shown' as const, image_id: imageId, width: 4, height: 4 }],
      }),
    );
    const server = Object.assign(createMockAgentUIServer(), {
      chatImages: {
        listTurnImages: vi.fn(),
        showTurnImages,
        imageUrl: ({ sessionId, imageId: id }: { sessionId: string; imageId: string }) =>
          `/api/chat-images/sessions/${sessionId}/images/${id}`,
      },
    });
    render(
      <ServerProvider server={server}>
        <RuntimeHarness messages={[sentImageMessage('turn-9-file-0')]} threadId="local-1" remoteId="session-1">
          <ThreadPrimitive.Messages>{() => <MessageAttachmentsContainer />}</ThreadPrimitive.Messages>
        </RuntimeHarness>
      </ServerProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Open attachment preview' }));
    expect(screen.getByRole('img', { name: 'Attachment preview' })).toHaveAttribute(
      'src',
      `/api/chat-images/sessions/session-1/images/${imageId}`,
    );
    expect(showTurnImages).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', turnId: 'turn-9', source: { kind: 'upload', index: 0 } }),
    );
  });
});
