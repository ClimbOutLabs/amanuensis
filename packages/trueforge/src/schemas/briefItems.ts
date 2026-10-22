import { BriefSectionSchema } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { z } from 'zod';

const ItemKeySchema = z.string().min(1).max(120);
const TitleSchema = z.string().min(1).max(200);

export const BriefItemCompletionSchema = z
  .object({
    item_key: ItemKeySchema.describe('Client key of the brief item.'),
    section: BriefSectionSchema,
    title: TitleSchema,
    completed_at: z.string().describe('When the item was marked done, ISO 8601 UTC.'),
  })
  .openapi('BriefItemCompletion');

export const MarkBriefItemDoneRequestSchema = z
  .object({
    item_key: ItemKeySchema.describe('Client key of the brief item.'),
    section: BriefSectionSchema,
    title: TitleSchema,
    session_id: z.string().min(1).describe('The chat the brief was shown in.'),
  })
  .openapi('MarkBriefItemDoneRequest');

export const MarkBriefItemDoneResponseSchema = z
  .object({ data: BriefItemCompletionSchema.describe('The item as marked done.') })
  .openapi('MarkBriefItemDoneResponse');

export const DeleteBriefItemDoneResponseSchema = z.object({}).openapi('DeleteBriefItemDoneResponse');

export const BriefItemKeyParamSchema = z
  .object({ item_key: ItemKeySchema.describe('Client key of the brief item.') })
  .openapi('BriefItemKeyParam');

export const ListBriefItemCompletionsRequestQuerySchema = z
  .object({
    since: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('Only items marked done at or after this time. Defaults to seven days ago.'),
  })
  .openapi('ListBriefItemCompletionsRequestQuery');

export const ListBriefItemCompletionsResponseSchema = z
  .object({
    data: z.array(BriefItemCompletionSchema).describe('Completed brief items, newest first.'),
  })
  .openapi('ListBriefItemCompletionsResponse');

export type BriefItemCompletion = z.infer<typeof BriefItemCompletionSchema>;
