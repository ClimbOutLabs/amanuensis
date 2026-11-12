// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import SkillSettings from '@/containers/SettingsBuilder/SkillSettings.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { SkillNetworkApprovalState } from '@/server/skillNetworkApproval.js';
import type { CreateSkillRequest, DefinedSkill, SkillCatalogEntry } from '@/server/types.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

const catalogEntry: SkillCatalogEntry = {
  id: 'cat-code-review',
  name: 'Code Review',
  description: 'Review a diff for correctness, risk and style.',
  repoURL: 'https://github.com/truefoundry/skills',
  path: 'skills/code-review',
  ref: 'main',
};

/** In-memory host: catalog is fixed, defined skills live in a mutable list. */
function createFakeHost(
  initial: DefinedSkill[] = [],
  options: { networkApprovals?: Record<string, SkillNetworkApprovalState> } = {},
) {
  let defined = [...initial];
  const created: CreateSkillRequest[] = [];
  const approvals = new Map(Object.entries(options.networkApprovals ?? {}));
  const approvalCalls: { method: string; id: string; hosts?: string[] }[] = [];

  const skillCatalog = {
    getSkillCatalog: async () => [catalogEntry],
    listSkills: async () => defined,
    createSkill: async (req: CreateSkillRequest) => {
      created.push(req);
      const skill: DefinedSkill =
        'catalogId' in req
          ? {
              id: `db-${req.catalogId}`,
              name: req.name,
              description: req.description,
              catalogId: req.catalogId,
            }
          : {
              id: `db-${req.name}`,
              name: req.name,
              description: req.description,
            };
      defined = [...defined, skill];
      return skill;
    },
    deleteSkill: async ({ id }: { id: string }) => {
      defined = defined.filter(skill => skill.id !== id);
    },
    ...(options.networkApprovals === undefined
      ? {}
      : {
          getSkillNetworkApproval: async ({ id }: { id: string }) =>
            approvals.get(id) ?? { declaredHosts: [], approvedHosts: null, sendCapable: false },
          approveSkillNetwork: async ({ id, hosts }: { id: string; hosts: string[] }) => {
            approvalCalls.push({ method: 'approve', id, hosts });
            const next: SkillNetworkApprovalState = {
              declaredHosts: hosts,
              approvedHosts: hosts,
              sendCapable: approvals.get(id)?.sendCapable ?? false,
            };
            approvals.set(id, next);
            return next;
          },
          revokeSkillNetwork: async ({ id }: { id: string }) => {
            approvalCalls.push({ method: 'revoke', id });
            const current = approvals.get(id);
            if (current !== undefined) {
              approvals.set(id, { ...current, approvedHosts: null });
            }
          },
        }),
  };

  const server = createMockAgentUIServer({
    catalog: createMockCatalog({ skillCatalog }),
  });

  return {
    created,
    approvalCalls,
    getDefined: () => defined,
    wrapper: ({ children }: { children: ReactNode }) => <ServerProvider server={server}>{children}</ServerProvider>,
  };
}

describe('SkillSettings', () => {
  it('selects a catalog skill and moves it out of Available', async () => {
    const host = createFakeHost();
    const { wrapper: Wrapper } = host;

    render(
      <Wrapper>
        <SkillSettings />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Enable Code Review' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove Code Review' })).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Enable Code Review' })).toBeNull();
    expect(host.created).toEqual([
      {
        catalogId: catalogEntry.id,
        name: catalogEntry.name,
        description: catalogEntry.description,
        repoURL: catalogEntry.repoURL,
        path: catalogEntry.path,
        ref: catalogEntry.ref,
      },
    ]);
  });

  it('returns a removed registry skill to Available', async () => {
    const { wrapper: Wrapper } = createFakeHost([
      {
        id: 'db-cat-code-review',
        name: catalogEntry.name,
        description: catalogEntry.description,
        catalogId: catalogEntry.id,
      },
    ]);

    render(
      <Wrapper>
        <SkillSettings />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Code Review' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Enable Code Review' })).toBeTruthy();
    });
  });

  it('removes an imported github skill entirely, after confirming', async () => {
    const host = createFakeHost([
      {
        id: 'db-house-style',
        name: 'House Style',
        description: 'Writing rules and tone-of-voice for external copy.',
      },
    ]);
    const { wrapper: Wrapper } = host;

    render(
      <Wrapper>
        <SkillSettings />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Remove House Style' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Remove skill' }));

    await waitFor(() => {
      expect(screen.queryByText('House Style')).toBeNull();
    });
    expect(host.getDefined()).toEqual([]);
  });

  it('cancelling the confirm dialog keeps the imported skill', async () => {
    const host = createFakeHost([
      {
        id: 'db-house-style',
        name: 'House Style',
        description: 'Writing rules and tone-of-voice for external copy.',
      },
    ]);
    const { wrapper: Wrapper } = host;

    render(
      <Wrapper>
        <SkillSettings />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Remove House Style' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('House Style')).toBeTruthy();
    expect(host.getDefined()).toEqual([
      {
        id: 'db-house-style',
        name: 'House Style',
        description: 'Writing rules and tone-of-voice for external copy.',
      },
    ]);
  });

  it('the confirm dialog calls deleteSkill with the skill id (name)', async () => {
    const deleteSkill = vi.fn(async () => {});
    const skillCatalog = {
      getSkillCatalog: async () => [catalogEntry],
      listSkills: async () => [
        {
          id: 'house-style',
          name: 'House Style',
          description: 'Writing rules and tone-of-voice for external copy.',
        },
      ],
      createSkill: vi.fn(),
      deleteSkill,
    };
    const server = createMockAgentUIServer({ catalog: createMockCatalog({ skillCatalog }) });

    render(
      <ServerProvider server={server}>
        <SkillSettings />
      </ServerProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Remove House Style' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove skill' }));

    await waitFor(() => expect(deleteSkill).toHaveBeenCalledWith({ id: 'house-style' }));
  });

  it('hides the Remove button when the host cannot remove skills', async () => {
    const skillCatalog = {
      getSkillCatalog: async () => [catalogEntry],
      listSkills: async () => [
        {
          id: 'house-style',
          name: 'House Style',
          description: 'Writing rules and tone-of-voice for external copy.',
        },
      ],
      createSkill: vi.fn(),
    };
    const server = createMockAgentUIServer({ catalog: createMockCatalog({ skillCatalog }) });

    render(
      <ServerProvider server={server}>
        <SkillSettings />
      </ServerProvider>,
    );

    await screen.findByText('House Style');
    expect(screen.queryByRole('button', { name: 'Remove House Style' })).toBeNull();
  });

  it('imports a github skill without a type discriminant', async () => {
    const host = createFakeHost();
    const { wrapper: Wrapper } = host;

    render(
      <Wrapper>
        <SkillSettings />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Import from GitHub/ }));

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'House Style' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Writing rules' },
    });
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/org/repo' },
    });
    fireEvent.change(screen.getByLabelText('Folder containing the SKILL.md'), {
      target: { value: 'skills/house-style' },
    });
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'main' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(host.created).toEqual([
        {
          name: 'House Style',
          description: 'Writing rules',
          repoURL: 'https://github.com/org/repo',
          path: 'skills/house-style',
          ref: 'main',
        },
      ]);
    });
  });

  it('disables settings writes after TrueFoundry returns 424', async () => {
    const createSkill = vi.fn(async () => {
      throw Object.assign(new Error('Failed dependency'), {
        statusCode: 424,
        body: { error: { message: 'This resource is managed by TrueFoundry' } },
      });
    });
    const server = createMockAgentUIServer({
      catalog: createMockCatalog({
        skillCatalog: {
          getSkillCatalog: async () => [catalogEntry],
          listSkills: async () => [],
          createSkill,
        },
      }),
    });

    render(
      <ServerProvider server={server}>
        <SkillSettings />
      </ServerProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Enable Code Review' }));

    expect(await screen.findByText('This resource is managed by TrueFoundry')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable Code Review' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Import from GitHub/ })).toBeDisabled();
    expect(createSkill).toHaveBeenCalledOnce();
  });
});

describe('SkillSettings network approval', () => {
  const tenX: DefinedSkill = { id: 'ten-x', name: 'ten-x', description: 'Works with GitHub from the sandbox.' };
  const tenXApproval: SkillNetworkApprovalState = {
    declaredHosts: ['github.com', 'api.github.com'],
    approvedHosts: null,
    sendCapable: false,
  };

  it('shows the declared sites with the approval wording, and Allow stores the approval', async () => {
    const host = createFakeHost([tenX], { networkApprovals: { 'ten-x': tenXApproval } });
    const { wrapper: Wrapper } = host;

    render(
      <Wrapper>
        <SkillSettings />
      </Wrapper>,
    );

    expect(await screen.findByText('The ten-x skill needs to reach these sites to work:')).toBeTruthy();
    expect(screen.getByText('github.com')).toBeTruthy();
    expect(screen.getByText('api.github.com')).toBeTruthy();
    expect(
      screen.getByText(
        /While this skill is switched on for a chat, that chat’s sandbox can contact these sites and no others/,
      ),
    ).toBeTruthy();
    // GitHub cannot send mail, so no sending line appears for it.
    expect(screen.queryByText(/will be able to send email as you/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove network access' })).toBeTruthy();
    });
    expect(host.approvalCalls).toEqual([{ method: 'approve', id: 'ten-x', hosts: ['github.com', 'api.github.com'] }]);
    expect(screen.getByText(/Network access is on for this skill/)).toBeTruthy();
  });

  it('Remove network access takes the approval back and the prompt returns', async () => {
    const host = createFakeHost([tenX], {
      networkApprovals: { 'ten-x': { ...tenXApproval, approvedHosts: ['github.com', 'api.github.com'] } },
    });
    const { wrapper: Wrapper } = host;

    render(
      <Wrapper>
        <SkillSettings />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Remove network access' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
    });
    expect(host.approvalCalls).toEqual([{ method: 'revoke', id: 'ten-x' }]);
  });

  it('names the sending when a declared site can send email', async () => {
    const google: DefinedSkill = { id: 'google', name: 'google', description: 'Reads mail and calendar.' };
    const host = createFakeHost([google], {
      networkApprovals: {
        google: { declaredHosts: ['gmail.googleapis.com'], approvedHosts: null, sendCapable: true },
      },
    });
    const { wrapper: Wrapper } = host;

    render(
      <Wrapper>
        <SkillSettings />
      </Wrapper>,
    );

    expect(
      await screen.findByText(
        'One of these sites can send email. This skill will be able to send email as you, without asking each time.',
      ),
    ).toBeTruthy();
  });

  it('a skill that declares no sites shows no panel', async () => {
    const host = createFakeHost([tenX], {
      networkApprovals: { 'ten-x': { declaredHosts: [], approvedHosts: null, sendCapable: false } },
    });
    const { wrapper: Wrapper } = host;

    render(
      <Wrapper>
        <SkillSettings />
      </Wrapper>,
    );

    expect(await screen.findByRole('button', { name: 'Remove ten-x' })).toBeTruthy();
    expect(screen.queryByText(/needs to reach these sites/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  });
});
