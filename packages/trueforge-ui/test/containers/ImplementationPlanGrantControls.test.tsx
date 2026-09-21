// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  ImplementationPlanGrantProvider,
  type ImplementationPlanGrant,
} from '@/components/ImplementationPlanGrantContext.js';
import { ImplementationPlanGrantControls } from '@/containers/ImplementationPlanGrantControls.js';

const grant: ImplementationPlanGrant = {
  kind: 'implementation_plan.v1',
  grant_id: 'plan_grant_123',
  plan_hash: 'abc123',
  workspace_cwd: '/repo',
  checkout_id: `sha256:${'1'.repeat(64)}`,
  tenant_id: 'tenant-1',
  created_by: 'user-1',
  session_id: 'session-1',
  plan: {
    repository_id: 'repo-1',
    repository_revision: 4,
    branch: 'feature/plan-grants',
    head_sha: '0123456789abcdef',
    file_globs: ['src/exact.ts', 'test/exact.test.ts'],
    approach: 'Persist and expose implementation-plan grants.',
    verify_command_ids: ['test:focused'],
  },
};

describe('ImplementationPlanGrantControls', () => {
  it('lists and revokes an active grant while the thread is idle', async () => {
    const listImplementationPlanGrants = vi.fn().mockResolvedValue([grant]);
    const revokeImplementationPlanGrant = vi.fn().mockResolvedValue(undefined);

    render(
      <ImplementationPlanGrantProvider api={{ listImplementationPlanGrants, revokeImplementationPlanGrant }}>
        <ImplementationPlanGrantControls sessionId="session-1" isRunning={false} />
      </ImplementationPlanGrantProvider>,
    );

    expect(await screen.findByRole('region', { name: 'Active implementation plans' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Revoke ${grant.plan.approach}` }));
    expect(revokeImplementationPlanGrant).toHaveBeenCalledWith({
      sessionId: 'session-1',
      grantId: grant.grant_id,
    });
  });

  it('keeps the session-scoped grant visible and revocable while a turn is running', async () => {
    const listImplementationPlanGrants = vi.fn().mockResolvedValue([grant]);
    const revokeImplementationPlanGrant = vi.fn().mockResolvedValue(undefined);

    render(
      <ImplementationPlanGrantProvider api={{ listImplementationPlanGrants, revokeImplementationPlanGrant }}>
        <ImplementationPlanGrantControls sessionId="session-1" isRunning />
      </ImplementationPlanGrantProvider>,
    );

    expect(await screen.findByRole('region', { name: 'Active implementation plans' })).toBeInTheDocument();
    expect(screen.getByText(grant.plan.approach)).toBeInTheDocument();
    expect(screen.getByText('feature/plan-grants @ 01234567 · revision 4')).toBeInTheDocument();
    expect(screen.getByText('src/exact.ts')).toBeInTheDocument();
    expect(screen.getByText('test:focused')).toBeInTheDocument();
    expect(listImplementationPlanGrants).toHaveBeenCalledWith('session-1');

    fireEvent.click(screen.getByRole('button', { name: `Revoke ${grant.plan.approach}` }));

    expect(revokeImplementationPlanGrant).toHaveBeenCalledWith({
      sessionId: 'session-1',
      grantId: grant.grant_id,
    });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Active implementation plans' })).not.toBeInTheDocument();
    });
  });

  it('keeps the active grant visible when the turn becomes idle', async () => {
    const listImplementationPlanGrants = vi.fn().mockResolvedValue([grant]);
    const revokeImplementationPlanGrant = vi.fn().mockResolvedValue(undefined);

    const { rerender } = render(
      <ImplementationPlanGrantProvider api={{ listImplementationPlanGrants, revokeImplementationPlanGrant }}>
        <ImplementationPlanGrantControls sessionId="session-1" isRunning />
      </ImplementationPlanGrantProvider>,
    );

    expect(await screen.findByText(grant.plan.approach)).toBeInTheDocument();
    rerender(
      <ImplementationPlanGrantProvider api={{ listImplementationPlanGrants, revokeImplementationPlanGrant }}>
        <ImplementationPlanGrantControls sessionId="session-1" isRunning={false} />
      </ImplementationPlanGrantProvider>,
    );
    expect(await screen.findByText(grant.plan.approach)).toBeInTheDocument();
    expect(revokeImplementationPlanGrant).not.toHaveBeenCalled();
  });

  it('does not show a response from a session that is no longer selected', async () => {
    let resolveFirst: ((grants: ImplementationPlanGrant[]) => void) | undefined;
    const first = new Promise<ImplementationPlanGrant[]>(resolve => {
      resolveFirst = resolve;
    });
    const listImplementationPlanGrants = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce([]);

    const { rerender } = render(
      <ImplementationPlanGrantProvider
        api={{ listImplementationPlanGrants, revokeImplementationPlanGrant: vi.fn().mockResolvedValue(undefined) }}
      >
        <ImplementationPlanGrantControls sessionId="session-1" isRunning />
      </ImplementationPlanGrantProvider>,
    );

    rerender(
      <ImplementationPlanGrantProvider
        api={{ listImplementationPlanGrants, revokeImplementationPlanGrant: vi.fn().mockResolvedValue(undefined) }}
      >
        <ImplementationPlanGrantControls sessionId="session-2" isRunning />
      </ImplementationPlanGrantProvider>,
    );
    await waitFor(() => {
      expect(listImplementationPlanGrants).toHaveBeenCalledWith('session-2');
    });
    resolveFirst?.([grant]);

    await waitFor(() => {
      expect(screen.queryByText(grant.plan.approach)).not.toBeInTheDocument();
    });
  });
});
