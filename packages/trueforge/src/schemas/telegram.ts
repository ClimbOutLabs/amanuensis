import { z } from '@hono/zod-openapi';

/**
 * Wire shapes for the Telegram channel: the Settings card, the updates the controller hands to the
 * server, and the updates Telegram itself posts to the webhook. Field names are snake_case, as on
 * every other wire in this package. The bot token is write-only: it is accepted on connect and
 * never returned, logged or stored anywhere but the connection row.
 */

/** Where a connection stands: no bot yet, a bot waiting to be paired, or paired and live. */
export const TelegramConnectionStateSchema = z
  .enum(['not_connected', 'awaiting_pairing', 'connected'])
  .openapi('TelegramConnectionState');

export type TelegramConnectionState = z.infer<typeof TelegramConnectionStateSchema>;

export const TelegramAccountStatusSchema = z
  .object({
    available: z.boolean().describe('Whether this instance offers Telegram at all; when false, no card is shown.'),
    state: TelegramConnectionStateSchema,
    bot_name: z.string().nullable().describe('The bot name Telegram shows; null when no bot is connected.'),
    bot_username: z.string().nullable().describe('The bot username, without the @; null when no bot is connected.'),
    pairing_name: z
      .string()
      .nullable()
      .describe(
        'The name Telegram shows for the person waiting to pair, so they can be checked before pairing; null when nobody waits. The pairing code itself is never returned: the bot shows it only in Telegram.',
      ),
  })
  .openapi('TelegramAccountStatus');

export type TelegramAccountStatus = z.infer<typeof TelegramAccountStatusSchema>;

export const GetTelegramAccountResponseSchema = z
  .object({ data: TelegramAccountStatusSchema })
  .openapi('GetTelegramAccountResponse');

export const ConnectTelegramRequestSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .describe(
        'The bot token from BotFather. Write-only: it is checked with Telegram, saved with the connection, and never returned.',
      ),
  })
  .openapi('ConnectTelegramRequest');

export type ConnectTelegramRequest = z.infer<typeof ConnectTelegramRequestSchema>;

export const ConnectTelegramResponseSchema = z
  .object({ data: TelegramAccountStatusSchema })
  .openapi('ConnectTelegramResponse');

export const ConfirmTelegramPairingRequestSchema = z
  .object({
    code: z
      .string()
      .describe('The six-digit code the bot sent in Telegram after /start, typed to confirm the pairing.'),
  })
  .openapi('ConfirmTelegramPairingRequest');

export type ConfirmTelegramPairingRequest = z.infer<typeof ConfirmTelegramPairingRequestSchema>;

export const ConfirmTelegramPairingResponseSchema = z
  .object({ data: TelegramAccountStatusSchema })
  .openapi('ConfirmTelegramPairingResponse');

export const CancelTelegramPairingResponseSchema = z
  .object({ data: TelegramAccountStatusSchema })
  .openapi('CancelTelegramPairingResponse');

export const RemoveTelegramResponseSchema = z
  .object({ data: TelegramAccountStatusSchema })
  .openapi('RemoveTelegramResponse');

/** A Telegram user, as Telegram sends it. Only the fields the channel reads are named. */
export const TelegramUserSchema = z
  .object({
    id: z.number().int().describe('Telegram user id.'),
    is_bot: z.boolean().optional().describe('True when the account is a bot.'),
    first_name: z.string().optional().describe('First name, when Telegram sends one.'),
    username: z.string().optional().describe('Username without the @, when the person has one.'),
  })
  .openapi('TelegramUser');

export type TelegramUser = z.infer<typeof TelegramUserSchema>;

/** A Telegram chat, as Telegram sends it. Group and channel chats are refused by the channel. */
export const TelegramChatSchema = z
  .object({
    id: z.number().int().describe('Telegram chat id.'),
    type: z.string().describe('private, group, supergroup or channel.'),
  })
  .openapi('TelegramChat');

export type TelegramChat = z.infer<typeof TelegramChatSchema>;

export const TelegramPhotoSizeSchema = z
  .object({
    file_id: z.string().describe('File id to fetch the photo with.'),
    file_unique_id: z.string().optional().describe('Stable file id across bots.'),
    width: z.number().int().optional().describe('Width in pixels.'),
    height: z.number().int().optional().describe('Height in pixels.'),
    file_size: z.number().int().optional().describe('Size in bytes, when Telegram says.'),
  })
  .openapi('TelegramPhotoSize');

export const TelegramDocumentSchema = z
  .object({
    file_id: z.string().describe('File id to fetch the document with.'),
    file_unique_id: z.string().optional().describe('Stable file id across bots.'),
    file_name: z.string().optional().describe('The name the sender gave the file.'),
    mime_type: z.string().optional().describe('The file type, when Telegram says.'),
    file_size: z.number().int().optional().describe('Size in bytes, when Telegram says.'),
  })
  .openapi('TelegramDocument');

/** A marked span inside a message text: a link, a mention, a command. Offsets count UTF-16 units, as JavaScript strings do. */
export const TelegramMessageEntitySchema = z
  .object({
    type: z.string().describe('url, text_link, bot_command, mention, and the rest of Telegram\u2019s kinds.'),
    offset: z.number().int().describe('Where the span starts in the text.'),
    length: z.number().int().describe('How long the span is.'),
    url: z.string().optional().describe('The address a text_link points at, when Telegram sends it.'),
  })
  .openapi('TelegramMessageEntity');

export type TelegramMessageEntity = z.infer<typeof TelegramMessageEntitySchema>;

/** One message, as Telegram sends it. Forwarded content arrives with a forward origin and is untrusted. */
export const TelegramMessageSchema = z
  .object({
    message_id: z.number().int().describe('Message id inside its chat.'),
    from: TelegramUserSchema.optional().describe('Who sent it; absent for channel posts.'),
    chat: TelegramChatSchema,
    date: z.number().int().describe('When it was sent, as a Unix time in seconds.'),
    text: z.string().optional().describe('The message text, when the message is text.'),
    caption: z.string().optional().describe('The caption on a photo or document, when there is one.'),
    entities: z.array(TelegramMessageEntitySchema).optional().describe('Marked spans in the text.'),
    caption_entities: z.array(TelegramMessageEntitySchema).optional().describe('Marked spans in the caption.'),
    photo: z
      .array(TelegramPhotoSizeSchema)
      .optional()
      .describe('Photo sizes, smallest first, when the message is a photo.'),
    document: TelegramDocumentSchema.optional().describe('The attached file, when the message carries one.'),
    forward_origin: z
      .unknown()
      .optional()
      .describe('Set when the message was forwarded from somewhere else; its presence marks the content untrusted.'),
  })
  .openapi('TelegramMessage');

export type TelegramMessage = z.infer<typeof TelegramMessageSchema>;

/** A tap on one of the buttons under a message the bot sent. */
export const TelegramCallbackQuerySchema = z
  .object({
    id: z.string().describe('Callback id, answered once so Telegram stops showing a spinner.'),
    from: TelegramUserSchema,
    message: TelegramMessageSchema.optional().describe('The message the button belongs to, when Telegram sends it.'),
    data: z.string().optional().describe('The button payload the bot set.'),
  })
  .openapi('TelegramCallbackQuery');

export type TelegramCallbackQuery = z.infer<typeof TelegramCallbackQuerySchema>;

/** One update from Telegram: a message, or a button tap. Other update kinds are not read. */
export const TelegramUpdateSchema = z
  .object({
    update_id: z.number().int().describe('Update id; the poll offset is the last one handled plus one.'),
    message: TelegramMessageSchema.optional().describe('A new message, when this update is one.'),
    callback_query: TelegramCallbackQuerySchema.optional().describe('A button tap, when this update is one.'),
  })
  .openapi('TelegramUpdate');

export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

/**
 * One update as Telegram posts it to the webhook. Only the id is promised at the door; the
 * handler checks the rest itself, so an update in a shape this build cannot read is dropped
 * with a success answer instead of an error Telegram would keep retrying.
 */
export const TelegramWebhookUpdateSchema = z
  .object({
    update_id: z.number().int().describe('Update id; the rest of the update is checked by the handler.'),
  })
  .loose()
  .openapi('TelegramWebhookUpdate');

export type TelegramWebhookUpdate = z.infer<typeof TelegramWebhookUpdateSchema>;

/** What the controller posts to the server for one update it polled: the connection it belongs to and the update. */
export const ProcessTelegramUpdateRequestSchema = z
  .object({
    connection_id: z.string().min(1).describe('The connection the update was polled for.'),
    update: TelegramUpdateSchema,
  })
  .openapi('ProcessTelegramUpdateRequest');

export type ProcessTelegramUpdateRequest = z.infer<typeof ProcessTelegramUpdateRequestSchema>;
