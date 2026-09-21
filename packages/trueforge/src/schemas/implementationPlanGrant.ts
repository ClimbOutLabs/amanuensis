import { z } from '@hono/zod-openapi';
import { ImplementationPlanGrantSchema } from '@truefoundry/trueforge-core/core';
import { SessionIdParamsSchema } from './session';

export const ImplementationPlanGrantParamsSchema = z
  .object({
    ...SessionIdParamsSchema.shape,
    grant_id: z.string().min(1).max(128).describe('Integrity-derived implementation-plan grant identifier.'),
  })
  .openapi('ImplementationPlanGrantParams');

export const ListImplementationPlanGrantsResponseSchema = z
  .object({ data: z.array(ImplementationPlanGrantSchema) })
  .openapi('ListImplementationPlanGrantsResponse');

export const RevokeImplementationPlanGrantResponseSchema = z
  .object({})
  .openapi('RevokeImplementationPlanGrantResponse');
