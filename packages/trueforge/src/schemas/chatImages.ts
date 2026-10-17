import { z } from 'zod';

/** Wire shapes of the browser-only chat image routes (`/api/chat-images`), outside the public API. */

/** Why an image is not shown. The UI turns each into one plain sentence. */
export const ChatImageRefusalSchema = z.enum([
  'unsupported_type',
  'too_large',
  'undecodable',
  'fetch_failed',
  'offline',
  'blocked',
  'sandbox_unavailable',
]);
export type ChatImageRefusal = z.infer<typeof ChatImageRefusalSchema>;

export const ChatImageIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

const UploadImageSourceSchema = z.object({
  kind: z.literal('upload'),
  /** Position of the file among the turn message attachments. */
  index: z.number().int().min(0).max(63),
});

const ArtifactImageSourceSchema = z.object({
  kind: z.literal('artifact'),
  /** Stored file path from the turn image list. */
  path: z.string().min(1).max(1024),
});

const EmailImageSourceSchema = z.object({
  kind: z.literal('email'),
  /** Email read whose linked images to show. */
  tool_call_id: z.string().min(1).max(256),
});

const ReplyImageSourceSchema = z.object({
  kind: z.literal('reply'),
  /** Image link as it appears in the reply. */
  url: z.string().min(1).max(2048),
});

export const ChatImageSourceSchema = z.discriminatedUnion('kind', [
  UploadImageSourceSchema,
  ArtifactImageSourceSchema,
  EmailImageSourceSchema,
  ReplyImageSourceSchema,
]);
export type ChatImageSource = z.infer<typeof ChatImageSourceSchema>;

export const CreateTurnImagesRequestSchema = z.object({
  source: ChatImageSourceSchema,
  /** True after the person chose to show images from the web on the card. */
  approved: z.boolean(),
});
export type CreateTurnImagesRequest = z.infer<typeof CreateTurnImagesRequestSchema>;

const ChatImageOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('shown'),
    image_id: ChatImageIdSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({ status: z.literal('refused'), reason: ChatImageRefusalSchema }),
]);
export type ChatImageOutcome = z.infer<typeof ChatImageOutcomeSchema>;

export const TurnImagesResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done'), images: z.array(ChatImageOutcomeSchema) }),
  z.object({
    status: z.literal('ask'),
    /** Images the card would show. */
    count: z.number().int().positive(),
    /** Site a single reply image comes from; null for an email. */
    host: z.string().nullable(),
  }),
]);
export type TurnImagesResult = z.infer<typeof TurnImagesResultSchema>;

export const TurnImageListSchema = z.object({
  /** Stored sandbox and tool images of the turn. */
  artifacts: z.array(z.object({ path: z.string(), name: z.string() })),
  /** Emails read this turn that link images. */
  emails: z.array(z.object({ tool_call_id: z.string(), count: z.number().int().positive() })),
});
export type TurnImageList = z.infer<typeof TurnImageListSchema>;
