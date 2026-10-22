// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RepositoryWorkProvider, type RepositoryWorkApi } from '@/components/RepositoryWorkContext.js';
import { ThreadWorkOnRepoControls } from '@/containers/WorkOnRepoControls.js';

// The server status the control reads; each test sets it before rendering.
let serverSandbox: { enabled: boolean } | null = { enabled: true };

vi.mock('@/server/ServerContext.js', () => ({
  useServerCapabilities: () => (serverSandbox === null ? null : { sandbox: serverSandbox }),
}));

const api: RepositoryWorkApi = {
  listGithubRepositories: vi.fn(),
  getGithubRepository: vi.fn(),
  startRepositoryWork: vi.fn(),
  getSessionRepository: vi.fn(),
  getRepository: vi.fn(),
  listCommandProposals: vi.fn(),
  confirmCommandProposal: vi.fn(),
  dismissCommandProposal: vi.fn(),
  unbindSessionRepository: vi.fn(),
};

describe('ThreadWorkOnRepoControls', () => {
  it('leaves the control out when the server has no sandbox at all', () => {
    serverSandbox = { enabled: false };

    const { container } = render(
      <RepositoryWorkProvider api={api}>
        <ThreadWorkOnRepoControls />
      </RepositoryWorkProvider>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: /Work on a repo/ })).not.toBeInTheDocument();
  });
});
