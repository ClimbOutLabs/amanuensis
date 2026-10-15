import { z } from '@hono/zod-openapi';
import { RunCodeStatusSchema } from '@truefoundry/trueforge-core/core';

export const GetRunCodeStatusResponseSchema = z
  .object({ data: RunCodeStatusSchema })
  .openapi('GetRunCodeStatusResponse');
