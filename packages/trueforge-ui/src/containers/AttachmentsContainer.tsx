'use client';

import { ComposerPrimitive, MessagePrimitive, useAui, useAuiState } from '@assistant-ui/react';

import { useUploadImageSrc } from '../chatImages/ChatImages.js';
import { useChatImagesPort } from '../chatImages/chatImageScope.js';
import { USER_MESSAGE_ATTACHMENT_PREVIEW_REM } from '../constants/attachments.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { isImageAttachment, useAttachmentPreviewSrc } from './useAttachmentPreviewSrc.js';

function ComposerAttachmentItem() {
  const AttachmentPreviewDialog = useSlot('AttachmentPreviewDialog');
  const AttachmentCard = useSlot('AttachmentCard');
  const aui = useAui();
  const name = useAuiState(s => s.attachment.name);
  const contentType = useAuiState(s => s.attachment.contentType);
  const type = useAuiState(s => s.attachment.type);
  const isImage = isImageAttachment(type, contentType);
  const previewSrc = useAttachmentPreviewSrc();

  return (
    <AttachmentPreviewDialog previewSrc={previewSrc}>
      <AttachmentCard
        name={name}
        contentType={contentType}
        previewSrc={previewSrc}
        isImage={isImage}
        size="chip"
        onRemove={() => void aui.attachment().remove()}
      />
    </AttachmentPreviewDialog>
  );
}

/** Sent attachments are numbered `<turn id>-file-<position>` by the runtime. */
const SENT_ATTACHMENT_ID = /^(.+)-file-(\d+)$/;

function MessageAttachmentItem() {
  const AttachmentPreviewDialog = useSlot('AttachmentPreviewDialog');
  const AttachmentCard = useSlot('AttachmentCard');
  const name = useAuiState(s => s.attachment.name);
  const contentType = useAuiState(s => s.attachment.contentType);
  const type = useAuiState(s => s.attachment.type);
  const attachmentId = useAuiState(s => s.attachment.id);
  const sessionId = useAuiState(s => s.threadListItem.remoteId ?? undefined);
  const isImage = isImageAttachment(type, contentType);
  const sent = isImage ? SENT_ATTACHMENT_ID.exec(attachmentId) : null;
  // A sent picture shows only its re-encoded copy, never the stored original; until that copy is
  // ready, or where it cannot be made, the chip shows the file name.
  const previewSrc = useUploadImageSrc({
    port: useChatImagesPort(),
    sessionId,
    turnId: sent?.[1],
    index: sent?.[2] === undefined ? undefined : Number(sent[2]),
  });

  const card = (
    <AttachmentCard
      name={name}
      contentType={contentType}
      previewSrc={previewSrc}
      isImage={isImage}
      size={isImage ? 'preview' : 'chip'}
      previewRem={USER_MESSAGE_ATTACHMENT_PREVIEW_REM}
    />
  );

  if (isImage && previewSrc) {
    return <AttachmentPreviewDialog previewSrc={previewSrc}>{card}</AttachmentPreviewDialog>;
  }

  return card;
}

export function ComposerAttachmentsContainer() {
  return (
    <div className="aui-composer-attachments flex w-full flex-row flex-wrap items-center gap-2 empty:hidden">
      <ComposerPrimitive.Attachments>{() => <ComposerAttachmentItem />}</ComposerPrimitive.Attachments>
    </div>
  );
}

export function MessageAttachmentsContainer() {
  return (
    <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row justify-end gap-2">
      <MessagePrimitive.Attachments>{() => <MessageAttachmentItem />}</MessagePrimitive.Attachments>
    </div>
  );
}

export function ComposerAttachmentPickerContainer() {
  const AttachmentPickerButton = useSlot('AttachmentPickerButton');
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <AttachmentPickerButton />
    </ComposerPrimitive.AddAttachment>
  );
}
