'use client';

import { useAuiState } from '@assistant-ui/react';

import { isChatImageSrc } from '../chatImages/chatImageScope.js';
import { USER_MESSAGE_ATTACHMENT_PREVIEW_REM } from '../constants/attachments.js';
import { useSlot } from '../theme/SlotsProvider.js';

export function MessageImageContainer() {
  const AttachmentCard = useSlot('AttachmentCard');
  const AttachmentPreviewDialog = useSlot('AttachmentPreviewDialog');
  const image = useAuiState(s => (s.part.type === 'image' ? s.part.image : ''));
  const filename = useAuiState(s => (s.part.type === 'image' ? s.part.filename : undefined));

  if (!image) {
    return null;
  }
  // Only a re-encoded image from this chat's image route is rendered; anything else (a web link, an
  // inline data image) shows as a named chip.
  if (!isChatImageSrc(image)) {
    return (
      <div className="aui-message-image">
        <AttachmentCard name={filename ?? 'image'} size="chip" previewRem={USER_MESSAGE_ATTACHMENT_PREVIEW_REM} />
      </div>
    );
  }

  const card = (
    <AttachmentCard
      name={filename ?? 'image'}
      previewSrc={image}
      isImage
      size="preview"
      previewRem={USER_MESSAGE_ATTACHMENT_PREVIEW_REM}
    />
  );

  return (
    <AttachmentPreviewDialog previewSrc={image}>
      <div className="aui-message-image">{card}</div>
    </AttachmentPreviewDialog>
  );
}
