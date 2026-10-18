import type { ChatImageRefusal } from '../plugins/trueforge-agent-server-adapter/catalogs/chatImagesCatalog.js';

/** What went wrong and the one thing to do, in two short sentences. */
export const CHAT_IMAGE_REFUSAL_TEXT: Record<ChatImageRefusal, string> = {
  unsupported_type: "This isn't a picture type Aman can show. Ask for a PNG, JPEG, GIF or WebP copy.",
  too_large: 'This image is too large to show. Ask for a smaller copy.',
  undecodable: 'This image looks damaged, so it is not shown. Ask for a fresh copy.',
  fetch_failed: "This image couldn't be downloaded. Try again later.",
  offline: 'Images from the web are off while offline. Turn off Offline mode in Settings → Permissions to see it.',
  blocked: 'This link was blocked because it could send private data. Ask for the image another way.',
  sandbox_unavailable: 'Image checks need the sandbox, which is off. Open Settings → Sandbox to turn it on.',
};

/** Shown when a request for an image fails outright. */
export const CHAT_IMAGE_ERROR_TEXT = "The image couldn't be loaded. Try again later.";
