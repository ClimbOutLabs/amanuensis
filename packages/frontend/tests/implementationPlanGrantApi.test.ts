import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImplementationPlanGrantApi } from '../src/implementationPlanGrantApi';

const grant = {
  kind: 'implementation_plan.v1',
  grant_id: 'plan_grant_123',
  plan_hash: 'abc123',
  workspace_cwd: '/repo',
  checkout_id: `sha256:${'1'.repeat(64)}`,
  tenant_id: 'tenant-1',
  created_by: 'user-1',
  session_id: 'session/one',
  plan: {
    repository_id: 'repo-1',
    repository_revision: 4,
    branch: 'feature/plan-grants',
    head_sha: '0123456789abcdef',
    file_globs: ['src/exact.ts'],
    approach: 'Persist implementation-plan grants.',
    verify_command_ids: ['test:focused'],
  },
};

test('implementation-plan grant API lists and revokes on owner-scoped session routes', async () => {
  const requests: Request[] = [];
  const api = createImplementationPlanGrantApi(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    requests.push(request);
    return request.method === 'GET' ? Response.json({ data: [grant] }) : Response.json({});
  });

  assert.deepEqual(await api.listImplementationPlanGrants(grant.session_id), [grant]);
  await api.revokeImplementationPlanGrant({
    sessionId: grant.session_id,
    grantId: 'plan grant/123',
  });

  assert.deepEqual(
    requests.map(request => [request.method, new URL(request.url).pathname]),
    [
      ['GET', '/api/v1/sessions/session%2Fone/implementation-plan-grants'],
      ['DELETE', '/api/v1/sessions/session%2Fone/implementation-plan-grants/plan%20grant%2F123'],
    ],
  );
});

test('implementation-plan grant API rejects malformed durable scope data', async () => {
  const api = createImplementationPlanGrantApi(async () =>
    Response.json({ data: [{ ...grant, plan: { ...grant.plan, file_globs: 'src/**' } }] }),
  );

  await assert.rejects(
    api.listImplementationPlanGrants(grant.session_id),
    /implementation plan grant response was invalid/i,
  );
});

test('implementation-plan grant API surfaces revoke failures', async () => {
  const api = createImplementationPlanGrantApi(async () =>
    Response.json({ error: { message: 'Grant does not belong to this session.' } }, { status: 403 }),
  );

  await assert.rejects(
    api.revokeImplementationPlanGrant({ sessionId: grant.session_id, grantId: grant.grant_id }),
    /does not belong to this session/i,
  );
});
