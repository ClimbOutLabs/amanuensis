'use client';

import { useAuiState } from '@assistant-ui/react';
import { useEffect, useState } from 'react';

export function isImageAttachment(type: string, contentType?: string): boolean {
  return type === 'image' || (contentType?.startsWith('image/') ?? false);
}

function useFileObjectUrl(file: File | undefined): string | undefined {
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!file) {
      setSrc(undefined);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setSrc(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return src;
}

/**
 * Preview URL (object URL) for a picture the person picked on this device. Stored attachments have no
 * local preview: chat shows only their re-encoded copy.
 */
export function useAttachmentPreviewSrc(): string | undefined {
  const type = useAuiState(s => s.attachment.type);
  const contentType = useAuiState(s => s.attachment.contentType);
  const file = useAuiState(s => ('file' in s.attachment ? s.attachment.file : undefined));
  const image = isImageAttachment(type, contentType);
  return useFileObjectUrl(image ? file : undefined);
}
