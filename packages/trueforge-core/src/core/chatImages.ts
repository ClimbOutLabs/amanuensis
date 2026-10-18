/** Picture types chat accepts as input; anything else is refused or stays a file. */
export type ChatImageInputType = 'png' | 'jpeg' | 'gif' | 'webp';

/** The MIME type each accepted picture type is declared as, compared after lowercasing. */
export const CHAT_IMAGE_INPUT_MIME_TYPES: ReadonlyMap<string, ChatImageInputType> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

/** Linked images one email may offer the chat. */
export const CHAT_IMAGE_MAX_PER_EMAIL = 20;
