import type {
  ImplementationPlan,
  ImplementationPlanGrant,
} from '@truefoundry/trueforge-core/core/mcp/implementationPlanGrant';
import type { ImplementationPlanGrantApi } from '@truefoundry/trueforge-ui';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function asUnknown(value: unknown): unknown {
  return value;
}

function parseImplementationPlan(value: unknown): ImplementationPlan {
  if (!isRecord(value)) {
    throw new Error('The implementation plan grant response was invalid.');
  }
  const { repository_id, repository_revision, branch, head_sha, file_globs, approach, verify_command_ids } = value;
  if (
    typeof repository_id !== 'string' ||
    typeof repository_revision !== 'number' ||
    !Number.isSafeInteger(repository_revision) ||
    repository_revision < 0 ||
    typeof branch !== 'string' ||
    typeof head_sha !== 'string' ||
    !isStringArray(file_globs) ||
    typeof approach !== 'string' ||
    !isStringArray(verify_command_ids)
  ) {
    throw new Error('The implementation plan grant response was invalid.');
  }
  return {
    repository_id,
    repository_revision,
    branch,
    head_sha,
    file_globs,
    approach,
    verify_command_ids,
  };
}

function parseImplementationPlanGrant(value: unknown): ImplementationPlanGrant {
  if (!isRecord(value)) {
    throw new Error('The implementation plan grant response was invalid.');
  }
  const { kind, grant_id, plan_hash, workspace_cwd, checkout_id, tenant_id, created_by, session_id, plan } = value;
  if (
    kind !== 'implementation_plan.v1' ||
    typeof grant_id !== 'string' ||
    typeof plan_hash !== 'string' ||
    typeof workspace_cwd !== 'string' ||
    typeof checkout_id !== 'string' ||
    typeof tenant_id !== 'string' ||
    typeof created_by !== 'string' ||
    typeof session_id !== 'string'
  ) {
    throw new Error('The implementation plan grant response was invalid.');
  }
  return {
    kind,
    grant_id,
    plan_hash,
    workspace_cwd,
    checkout_id,
    tenant_id,
    created_by,
    session_id,
    plan: parseImplementationPlan(plan),
  };
}

function responseErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  if (isRecord(body.error) && typeof body.error.message === 'string') {
    return body.error.message;
  }
  return typeof body.message === 'string' ? body.message : undefined;
}

async function readError(response: Response): Promise<Error> {
  const body = asUnknown(await response.json().catch(() => null));
  return new Error(responseErrorMessage(body) ?? `Request failed (${String(response.status)}).`);
}

async function readData(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw await readError(response);
  }
  const body = asUnknown(await response.json());
  if (!isRecord(body) || !Object.hasOwn(body, 'data')) {
    throw new Error('The implementation plan grant response was invalid.');
  }
  return body.data;
}

export function createImplementationPlanGrantApi(fetcher: typeof fetch): ImplementationPlanGrantApi {
  const grantsUrl = (sessionId: string) =>
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/implementation-plan-grants`;

  return {
    async listImplementationPlanGrants(sessionId: string) {
      const data = await readData(await fetcher(grantsUrl(sessionId)));
      if (!isUnknownArray(data)) {
        throw new Error('The implementation plan grant response was invalid.');
      }
      return data.map(parseImplementationPlanGrant);
    },
    async revokeImplementationPlanGrant({ sessionId, grantId }: { sessionId: string; grantId: string }) {
      const response = await fetcher(`${grantsUrl(sessionId)}/${encodeURIComponent(grantId)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw await readError(response);
      }
    },
  };
}
