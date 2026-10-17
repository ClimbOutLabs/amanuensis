import { z } from '@hono/zod-openapi';

import { SessionIdParamsSchema } from './session';

/** Why an image is not shown. The UI turns each into one plain sentence. */
export const ChatImageRefusalSchema = z
  .enum(['unsupported_type', 'too_large', 'undecodable', 'fetch_failed', 'offline', 'blocked', 'sandbox_unavailable'])
  .openapi('ChatImageRefusal');
export type ChatImageRefusal = z.infer<typeof ChatImageRefusalSchema>;

export const ChatImageIdParamsSchema = z
  .object({
    ...SessionIdParamsSchema.shape,
    image_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .describe('Image identifier.'),
  })
  .openapi('ChatImageIDParams');

export const UploadImageSourceSchema = z
  .object({
    kind: z.literal('upload'),
    index: z.number().int().min(0).max(63).describe('Position of the file among the turn message attachments.'),
  })
  .openapi('UploadImageSource');

export const ArtifactImageSourceSchema = z
  .object({
    kind: z.literal('artifact'),
    path: z.string().min(1).max(1024).describe('Stored file path from the turn image list.'),
  })
  .openapi('ArtifactImageSource');

export const EmailImageSourceSchema = z
  .object({
    kind: z.literal('email'),
    tool_call_id: z.string().min(1).max(256).describe('Email read whose linked images to show.'),
  })
  .openapi('EmailImageSource');

export const ReplyImageSourceSchema = z
  .object({
    kind: z.literal('reply'),
    url: z.string().min(1).max(2048).describe('Image link exactly as it appears in the reply.'),
  })
  .openapi('ReplyImageSource');

export const ChatImageSourceSchema = z
  .discriminatedUnion('kind', [
    UploadImageSourceSchema,
    ArtifactImageSourceSchema,
    EmailImageSourceSchema,
    ReplyImageSourceSchema,
  ])
  .openapi('ChatImageSource');
export type ChatImageSource = z.infer<typeof ChatImageSourceSchema>;

export const CreateTurnImagesRequestSchema = z
  .object({
    source: ChatImageSourceSchema,
    approved: z.boolean().describe('True after the person chose to show images from the web on the card.'),
  })
  .openapi('CreateTurnImagesRequest');
export type CreateTurnImagesRequest = z.infer<typeof CreateTurnImagesRequestSchema>;

export const ShownChatImageSchema = z
  .object({
    status: z.literal('shown'),
    image_id: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .openapi('ShownChatImage');

export const RefusedChatImageSchema = z
  .object({
    status: z.literal('refused'),
    reason: ChatImageRefusalSchema,
  })
  .openapi('RefusedChatImage');

export const ChatImageOutcomeSchema = z
  .discriminatedUnion('status', [ShownChatImageSchema, RefusedChatImageSchema])
  .openapi('ChatImageOutcome');
export type ChatImageOutcome = z.infer<typeof ChatImageOutcomeSchema>;

export const ShownTurnImagesSchema = z
  .object({
    status: z.literal('done'),
    images: z.array(ChatImageOutcomeSchema),
  })
  .openapi('ShownTurnImages');

export const AskTurnImagesSchema = z
  .object({
    status: z.literal('ask'),
    count: z.number().int().positive().describe('Images the card would show.'),
    host: z.string().nullable().describe('Site a single reply image comes from; null for an email.'),
  })
  .openapi('AskTurnImages');

export const TurnImagesResultSchema = z
  .discriminatedUnion('status', [ShownTurnImagesSchema, AskTurnImagesSchema])
  .openapi('TurnImagesResult');
export type TurnImagesResult = z.infer<typeof TurnImagesResultSchema>;

export const CreateTurnImagesResponseSchema = z
  .object({ data: TurnImagesResultSchema })
  .openapi('CreateTurnImagesResponse');

export const TurnArtifactImageSchema = z
  .object({
    path: z.string(),
    name: z.string(),
  })
  .openapi('TurnArtifactImage');

export const TurnEmailImagesSchema = z
  .object({
    tool_call_id: z.string(),
    count: z.number().int().positive().describe('Linked images in the email, at most the per-email cap.'),
  })
  .openapi('TurnEmailImages');

export const TurnImageListSchema = z
  .object({
    artifacts: z.array(TurnArtifactImageSchema).describe('Stored sandbox and tool images of the turn.'),
    emails: z.array(TurnEmailImagesSchema).describe('Emails read this turn that link images.'),
  })
  .openapi('TurnImageList');
export type TurnImageList = z.infer<typeof TurnImageListSchema>;

export const ListTurnImagesResponseSchema = z.object({ data: TurnImageListSchema }).openapi('ListTurnImagesResponse');
