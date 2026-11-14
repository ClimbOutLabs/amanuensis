import { z } from '@hono/zod-openapi';

import { PageSortModeSchema } from '../runtime/memory/pageSortMode';

const SORT_MODE_HINT = 'Send `off`, `report` or `on`.';

export const MemoryPageSortingSchema = z
  .object({
    mode: PageSortModeSchema.describe('The stored setting: the persisted override when set, else the env default.'),
    overridden: z.boolean().describe('Whether a persisted override is currently stored.'),
    default_mode: PageSortModeSchema.describe('The `MEMORY_PAGE_SORTING` env default used when no override is stored.'),
  })
  .openapi('MemoryPageSorting');

export const UpdateMemoryPageSortingRequestSchema = z
  .object({
    mode: PageSortModeSchema.nullable().describe(
      `Persisted override. ${SORT_MODE_HINT} \`null\` clears the override back to the env default.`,
    ),
  })
  .openapi('UpdateMemoryPageSortingRequest', { example: { mode: 'report' } });

export const GetMemoryPageSortingResponseSchema = z
  .object({ data: MemoryPageSortingSchema })
  .openapi('GetMemoryPageSortingResponse');

export type MemoryPageSorting = z.infer<typeof MemoryPageSortingSchema>;
export type UpdateMemoryPageSortingRequest = z.infer<typeof UpdateMemoryPageSortingRequestSchema>;
