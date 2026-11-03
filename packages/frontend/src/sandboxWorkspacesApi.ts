import { SandboxWorkspaceListingSchema } from '@truefoundry/trueforge-core/core/sandbox/sandboxWorkspaceSchemas';
import type { SandboxWorkspacesApi } from '@truefoundry/trueforge-ui';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage({ body, status }: { body: unknown; status: number }): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    return body.error.message;
  }
  return `Request failed (${String(status)}).`;
}

export function createSandboxWorkspacesApi(fetcher: typeof fetch): SandboxWorkspacesApi {
  return {
    async listSandboxWorkspaces() {
      const response = await fetcher('/api/v1/settings/sandbox-workspaces');
      const body: unknown = await response.json().catch((): null => null);
      if (!response.ok) {
        throw new Error(errorMessage({ body, status: response.status }));
      }
      const parsed = SandboxWorkspaceListingSchema.safeParse(isRecord(body) ? body.data : undefined);
      if (!parsed.success) {
        throw new Error('The chat workspaces response was invalid.', { cause: parsed.error });
      }
      return parsed.data;
    },
  };
}
