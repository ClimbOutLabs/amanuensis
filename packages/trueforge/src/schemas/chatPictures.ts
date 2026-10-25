import { z } from 'zod';

/** Browser-only route that shows a picture from a chat page (`/api/chat-pictures`), outside the public API. */
export const ChatPictureQuerySchema = z.object({
  session_id: z.string().min(1),
  url: z.string().min(1).max(2048),
});
export type ChatPictureQuery = z.infer<typeof ChatPictureQuerySchema>;
