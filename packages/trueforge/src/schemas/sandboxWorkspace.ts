import { z } from '@hono/zod-openapi';
import { SandboxWorkspaceListingSchema } from '@truefoundry/trueforge-core/core';

export const ListSandboxWorkspacesResponseSchema = z
  .object({ data: SandboxWorkspaceListingSchema })
  .openapi('ListSandboxWorkspacesResponse');
