import { z } from 'zod';

/** Browser-only route that shows a picture from a space (`/api/space-pictures`), outside the public API. */
export const SpacePictureQuerySchema = z.object({
  url: z.string().min(1).max(2048),
});
export type SpacePictureQuery = z.infer<typeof SpacePictureQuerySchema>;
