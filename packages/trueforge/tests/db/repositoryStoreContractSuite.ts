import {
  RepositoryRevisionConflictError,
  RepositoryWorkspaceCwdError,
  VerifyCommandTimeoutError,
  type IRepositoryStore,
  type RepositoryRecord,
  type SessionBindingRecord,
  type VerifyCommandProposalInput,
} from '../../src/db/repositoryStore';

const OWNER_A = { tenant_id: 'tenant-a', created_by: 'owner-a' };
const OWNER_B = { tenant_id: 'tenant-a', created_by: 'owner-b' };

function repositoryInput(owner: typeof OWNER_A, name: string) {
  return {
    ...owner,
    name,
    clone_url: `https://example.test/${name}.git`,
    default_branch: 'main',
  };
}

function commandInput(repository: RepositoryRecord, commandId: string, expectedRevision?: number) {
  return {
    tenant_id: repository.tenant_id,
    created_by: repository.created_by,
    repository_id: repository.id,
    command_id: commandId,
    purpose: 'test' as const,
    command: 'pnpm test',
    timeout_ms: 60_000,
    expected_revision: expectedRevision,
  };
}

function proposalInput(repository: RepositoryRecord, id: string): VerifyCommandProposalInput {
  return {
    tenant_id: repository.tenant_id,
    created_by: repository.created_by,
    repository_id: repository.id,
    id,
    purpose: 'verify' as const,
    command: 'pnpm verify',
    source_kind: 'package_json',
    source_path: 'package.json',
    source_fingerprint: `sha256:${id}`,
  };
}

export function runRepositoryStoreContractSuite(
  getStore: () => IRepositoryStore,
  seedSession: (input: { tenant_id: string; created_by: string; session_id: string }) => Promise<void>,
  seedDurableVerificationResult: (input: {
    session_id: string;
    turn_id: string;
    thread_id: string;
    tool_call_id: string;
    event_id: string;
    parts: 'event' | 'context' | 'both';
  }) => Promise<void>,
): void {
  async function durableResult(tag: string) {
    const result = {
      session_id: `verification-session-${tag}`,
      turn_id: `verification-turn-${tag}`,
      thread_id: 'main',
      tool_call_id: `verification-call-${tag}`,
      event_id: `verification-event-${tag}`,
    };
    await seedSession({ ...OWNER_A, session_id: result.session_id });
    await seedDurableVerificationResult({ ...result, parts: 'both' });
    return {
      result_event_id: result.event_id,
      result_thread_id: result.thread_id,
      result_tool_call_id: result.tool_call_id,
    };
  }
  it('isolates repository records by tenant and owner', async () => {
    const store = getStore();
    const own = await store.createRepository(repositoryInput(OWNER_A, 'own'));
    await store.createRepository(repositoryInput(OWNER_B, 'other-owner'));
    await store.createRepository(repositoryInput({ tenant_id: 'tenant-b', created_by: 'owner-a' }, 'other-tenant'));

    expect(own.revision).toBe(0);
    expect((await store.listRepositories(OWNER_A)).map(repository => repository.name)).toEqual(['own']);
    expect(await store.getRepository({ ...OWNER_B, repository_id: own.id })).toBeUndefined();
    expect(
      await store.getRepository({ tenant_id: 'tenant-b', created_by: 'owner-a', repository_id: own.id }),
    ).toBeUndefined();
  });

  it('keeps package downloads off until allowed, and honours the revision check', async () => {
    const store = getStore();
    const repository = await store.createRepository(repositoryInput(OWNER_A, 'downloads'));
    expect(repository.package_downloads_allowed).toBe(false);

    const allowed = await store.setPackageDownloadsAllowed({
      ...OWNER_A,
      repository_id: repository.id,
      allowed: true,
      expected_revision: repository.revision,
    });
    expect(allowed?.package_downloads_allowed).toBe(true);
    expect(allowed?.revision).toBe(repository.revision + 1);
    expect((await store.getRepository({ ...OWNER_A, repository_id: repository.id }))?.package_downloads_allowed).toBe(
      true,
    );

    await expect(
      store.setPackageDownloadsAllowed({
        ...OWNER_A,
        repository_id: repository.id,
        allowed: false,
        expected_revision: repository.revision,
      }),
    ).rejects.toBeInstanceOf(RepositoryRevisionConflictError);

    const stopped = await store.setPackageDownloadsAllowed({
      ...OWNER_A,
      repository_id: repository.id,
      allowed: false,
      expected_revision: repository.revision + 1,
    });
    expect(stopped?.package_downloads_allowed).toBe(false);
    expect(
      await store.setPackageDownloadsAllowed({
        ...OWNER_B,
        repository_id: repository.id,
        allowed: true,
        expected_revision: undefined,
      }),
    ).toBeUndefined();
  });

  it('binds and unbinds an owned session with its workspace cwd', async () => {
    const store = getStore();
    const repository = await store.createRepository(repositoryInput(OWNER_A, 'bound'));
    await seedSession({ ...OWNER_A, session_id: 'session-a' });

    const bound = await store.bindSession({
      ...OWNER_A,
      session_id: 'session-a',
      repository_id: repository.id,
      workspace_cwd: 'C:/work/bound',
      expected_revision: repository.revision,
    });
    expect(bound).toEqual<SessionBindingRecord>({
      tenant_id: OWNER_A.tenant_id,
      session_id: 'session-a',
      created_by: OWNER_A.created_by,
      repository_id: repository.id,
      workspace_cwd: 'C:/work/bound',
    });

    expect(
      await store.bindSession({
        ...OWNER_B,
        session_id: 'session-a',
        repository_id: repository.id,
        workspace_cwd: 'C:/work/should-not-bind',
        expected_revision: undefined,
      }),
    ).toBeUndefined();

    const unbound = await store.unbindSession({
      ...OWNER_A,
      session_id: 'session-a',
      expected_revision: repository.revision,
    });
    expect(unbound).toEqual({
      tenant_id: OWNER_A.tenant_id,
      session_id: 'session-a',
      created_by: OWNER_A.created_by,
      repository_id: null,
      workspace_cwd: null,
    });
  });

  it('rejects a blank or relative workspace cwd before binding', async () => {
    const store = getStore();
    const repository = await store.createRepository(repositoryInput(OWNER_A, 'invalid-workspace'));
    await seedSession({ ...OWNER_A, session_id: 'session-invalid-workspace' });

    await expect(
      store.bindSession({
        ...OWNER_A,
        session_id: 'session-invalid-workspace',
        repository_id: repository.id,
        workspace_cwd: 'relative/path',
        expected_revision: undefined,
      }),
    ).rejects.toBeInstanceOf(RepositoryWorkspaceCwdError);
  });

  it('keeps proposed commands out of the confirmed-command query', async () => {
    const store = getStore();
    const repository = await store.createRepository(repositoryInput(OWNER_A, 'separation'));
    await store.upsertVerifyCommandProposal(proposalInput(repository, 'proposal-a'));

    expect(await store.listVerifyCommands({ ...OWNER_A, repository_id: repository.id })).toEqual([]);
    expect(
      (await store.listVerifyCommandProposals({ ...OWNER_A, repository_id: repository.id })).map(item => item.id),
    ).toEqual(['proposal-a']);
  });

  it('replaces one observed proposal source without disturbing another source or executable revision', async () => {
    const store = getStore();
    const repository = await store.createRepository(repositoryInput(OWNER_A, 'proposal-replacement'));
    await store.upsertVerifyCommandProposal(proposalInput(repository, 'old-package'));
    await store.upsertVerifyCommandProposal({
      ...proposalInput(repository, 'agents-verify'),
      source_kind: 'agents_md',
      source_path: 'AGENTS.md',
    });

    await store.replaceVerifyCommandProposals({
      ...OWNER_A,
      repository_id: repository.id,
      expected_revision: repository.revision,
      observed_sources: [{ source_kind: 'package_json', source_path: 'package.json' }],
      proposals: [
        {
          id: 'new-package',
          purpose: 'test',
          command: 'pnpm run test',
          source_kind: 'package_json',
          source_path: 'package.json',
          source_fingerprint: 'sha256:new-package',
        },
      ],
    });

    expect(
      (await store.listVerifyCommandProposals({ ...OWNER_A, repository_id: repository.id }))
        .map(item => item.id)
        .sort(),
    ).toEqual(['agents-verify', 'new-package']);
    expect((await store.getRepository({ ...OWNER_A, repository_id: repository.id }))?.revision).toBe(
      repository.revision,
    );
  });

  it('confirms a proposal atomically, increments revision, and removes the proposal', async () => {
    const store = getStore();
    const repository = await store.createRepository(repositoryInput(OWNER_A, 'confirmation'));
    await store.upsertVerifyCommandProposal(proposalInput(repository, 'proposal-a'));

    const confirmed = await store.confirmVerifyCommandProposal({
      ...OWNER_A,
      repository_id: repository.id,
      proposal_id: 'proposal-a',
      command_id: 'verify-default',
      timeout_ms: 120_000,
      expected_revision: 0,
    });
    expect(confirmed?.command).toEqual(
      expect.objectContaining({
        repository_id: repository.id,
        command_id: 'verify-default',
        purpose: 'verify',
        command: 'pnpm verify',
        timeout_ms: 120_000,
      }),
    );
    if (confirmed === undefined) {
      throw new Error('expected proposal confirmation to return a command');
    }
    expect(confirmed.repository_revision).toBe(1);
    expect(await store.listVerifyCommandProposals({ ...OWNER_A, repository_id: repository.id })).toEqual([]);
    expect(await store.listVerifyCommands({ ...OWNER_A, repository_id: repository.id })).toEqual([confirmed.command]);
    expect((await store.getRepository({ ...OWNER_A, repository_id: repository.id }))?.revision).toBe(1);
  });

  it('uses expected revision for command writes and leaves a stale confirmation untouched', async () => {
    const store = getStore();
    const repository = await store.createRepository(repositoryInput(OWNER_A, 'revisions'));
    await store.upsertVerifyCommandProposal(proposalInput(repository, 'proposal-a'));

    await expect(
      store.confirmVerifyCommandProposal({
        ...OWNER_A,
        repository_id: repository.id,
        proposal_id: 'proposal-a',
        command_id: 'verify-default',
        timeout_ms: 120_000,
        expected_revision: 9,
      }),
    ).rejects.toBeInstanceOf(RepositoryRevisionConflictError);
    expect((await store.getRepository({ ...OWNER_A, repository_id: repository.id }))?.revision).toBe(0);
    expect(
      (await store.listVerifyCommandProposals({ ...OWNER_A, repository_id: repository.id })).map(item => item.id),
    ).toEqual(['proposal-a']);

    const command = await store.upsertVerifyCommand(commandInput(repository, 'test-default', 0));
    expect(command?.command.command_id).toBe('test-default');
    expect(command?.repository_revision).toBe(1);
    expect((await store.getRepository({ ...OWNER_A, repository_id: repository.id }))?.revision).toBe(1);
    await store.deleteVerifyCommand({
      ...OWNER_A,
      repository_id: repository.id,
      command_id: 'test-default',
      expected_revision: 1,
    });
    expect((await store.getRepository({ ...OWNER_A, repository_id: repository.id }))?.revision).toBe(2);
  });

  it('rejects non-positive and over-bound verification timeouts', async () => {
    const store = getStore();
    const repository = await store.createRepository(repositoryInput(OWNER_A, 'timeout'));
    await expect(
      store.upsertVerifyCommand({ ...commandInput(repository, 'bad-zero'), timeout_ms: 0 }),
    ).rejects.toBeInstanceOf(VerifyCommandTimeoutError);
    await expect(
      store.upsertVerifyCommand({ ...commandInput(repository, 'bad-large'), timeout_ms: 3_600_001 }),
    ).rejects.toBeInstanceOf(VerifyCommandTimeoutError);
  });

  it('isolates command records and proposal deletion by owner', async () => {
    const store = getStore();
    const own = await store.createRepository(repositoryInput(OWNER_A, 'commands'));
    const other = await store.createRepository(repositoryInput(OWNER_B, 'commands'));
    await store.upsertVerifyCommand(commandInput(own, 'own-command', 0));
    await store.upsertVerifyCommand(commandInput(other, 'other-command', 0));
    await store.upsertVerifyCommandProposal(proposalInput(own, 'own-proposal'));

    expect(
      (await store.listVerifyCommands({ ...OWNER_A, repository_id: own.id })).map(item => item.command_id),
    ).toEqual(['own-command']);
    expect(await store.listVerifyCommands({ ...OWNER_B, repository_id: own.id })).toEqual([]);
    await store.deleteVerifyCommandProposal({ ...OWNER_B, repository_id: own.id, proposal_id: 'own-proposal' });
    expect(
      (await store.listVerifyCommandProposals({ ...OWNER_A, repository_id: own.id })).map(item => item.id),
    ).toEqual(['own-proposal']);
  });

  it('fences workspace receipts and semantic mutation epochs across store replicas', async () => {
    const first = getStore();
    const second = getStore();
    const repository = await first.createRepository(repositoryInput(OWNER_A, 'workspace-fence'));
    const base = { repository_id: repository.id, workspace_cwd: 'C:/work/workspace-fence' };
    const leaseA = { ...base, owner_id: 'replica-a', lease_id: 'lease-a' };
    const leaseB = { ...base, owner_id: 'replica-b', lease_id: 'lease-b' };
    const result = await durableResult('workspace-fence');

    await expect(first.acquireLease({ ...leaseA, lease_expires_at: new Date(Date.now() + 60_000) })).resolves.toEqual({
      mutation_epoch: 0,
    });
    await expect(
      first.activateReceipt({
        ...base,
        lease_id: leaseA.lease_id,
        mutation_epoch: 0,
        state_sha256: 'state-a',
        command: 'pnpm verify',
        created_at: new Date(),
        ...result,
      }),
    ).resolves.toBe(true);

    // A failed liveness/ownership attempt cannot mutate the live owner's receipt.
    await expect(
      second.acquireLease({ ...leaseB, lease_expires_at: new Date(Date.now() + 60_000) }),
    ).resolves.toBeUndefined();
    await expect(
      first.consumeReceipt({ ...base, lease_id: leaseA.lease_id, mutation_epoch: 0, state_sha256: 'state-a' }),
    ).resolves.toBe(true);

    await first.releaseLease({ ...base, lease_id: leaseA.lease_id });
    await expect(second.acquireLease({ ...leaseB, lease_expires_at: new Date(Date.now() + 60_000) })).resolves.toEqual({
      mutation_epoch: 0,
    });
    await expect(
      second.beginStateObservation({ ...base, lease_id: leaseB.lease_id, invalidate_receipt: false }),
    ).resolves.toBe(true);
    await expect(
      second.observeState({
        ...base,
        lease_id: leaseB.lease_id,
        before_state_sha256: 'state-a',
        after_state_sha256: 'state-a',
      }),
    ).resolves.toBe(0);
    await expect(
      second.activateReceipt({
        ...base,
        lease_id: leaseB.lease_id,
        mutation_epoch: 0,
        state_sha256: 'state-a',
        command: 'pnpm verify',
        created_at: new Date(),
        ...result,
      }),
    ).resolves.toBe(true);
    await expect(
      second.beginStateObservation({ ...base, lease_id: leaseB.lease_id, invalidate_receipt: false }),
    ).resolves.toBe(true);
    await expect(
      second.observeState({
        ...base,
        lease_id: leaseB.lease_id,
        before_state_sha256: 'state-a',
        after_state_sha256: 'state-b',
      }),
    ).resolves.toBe(1);
    await expect(
      second.consumeReceipt({ ...base, lease_id: leaseB.lease_id, mutation_epoch: 1, state_sha256: 'state-a' }),
    ).resolves.toBe(false);
  });

  it('activates only from a durable successful terminal result with matching tool context', async () => {
    const store = getStore();
    const repository = await store.createRepository(repositoryInput(OWNER_A, 'durable-result-boundary'));
    const base = { repository_id: repository.id, workspace_cwd: 'C:/work/durable-result-boundary' };
    const durable = {
      session_id: 'verification-session-durable-boundary',
      turn_id: 'verification-turn-durable-boundary',
      thread_id: 'main',
      tool_call_id: 'verification-call-durable-boundary',
      event_id: 'verification-event-durable-boundary',
    };
    const activation = {
      ...base,
      lease_id: 'durable-boundary-lease',
      mutation_epoch: 0,
      state_sha256: 'state-a',
      command: 'pnpm verify',
      created_at: new Date(),
      result_event_id: durable.event_id,
      result_thread_id: durable.thread_id,
      result_tool_call_id: durable.tool_call_id,
    };
    await store.acquireLease({
      ...base,
      owner_id: 'replica-a',
      lease_id: activation.lease_id,
      lease_expires_at: new Date(Date.now() + 60_000),
    });

    await expect(store.activateReceipt(activation)).resolves.toBe(false);
    await seedSession({ ...OWNER_A, session_id: durable.session_id });
    await seedDurableVerificationResult({ ...durable, parts: 'event' });
    await expect(store.activateReceipt(activation)).resolves.toBe(false);
    await seedDurableVerificationResult({ ...durable, parts: 'context' });
    await expect(store.activateReceipt(activation)).resolves.toBe(true);
  });

  it('allows expired workspace lease takeover and rejects stale-owner mutation', async () => {
    const first = getStore();
    const second = getStore();
    const repository = await first.createRepository(repositoryInput(OWNER_A, 'workspace-takeover'));
    const base = { repository_id: repository.id, workspace_cwd: 'C:/work/workspace-takeover' };
    await first.acquireLease({
      ...base,
      owner_id: 'replica-a',
      lease_id: 'expired-lease',
      lease_expires_at: new Date(Date.now() - 1_000),
    });
    await expect(
      second.acquireLease({
        ...base,
        owner_id: 'replica-b',
        lease_id: 'replacement-lease',
        lease_expires_at: new Date(Date.now() + 60_000),
      }),
    ).resolves.toEqual({ mutation_epoch: 0 });
    await expect(
      first.observeState({
        ...base,
        lease_id: 'expired-lease',
        before_state_sha256: 'before',
        after_state_sha256: 'after',
      }),
    ).resolves.toBeUndefined();
    await expect(
      first.renewLease({
        ...base,
        lease_id: 'expired-lease',
        lease_expires_at: new Date(Date.now() + 60_000),
      }),
    ).resolves.toBe(false);
  });

  it('renews an expired workspace lease when no takeover changed its generation', async () => {
    const store = getStore();
    const repository = await store.createRepository(repositoryInput(OWNER_A, 'workspace-renew-same-generation'));
    const base = { repository_id: repository.id, workspace_cwd: 'C:/work/workspace-renew-same-generation' };
    await store.acquireLease({
      ...base,
      owner_id: 'replica-a',
      lease_id: 'same-generation-lease',
      lease_expires_at: new Date(Date.now() - 1_000),
    });
    await expect(
      store.renewLease({
        ...base,
        lease_id: 'same-generation-lease',
        lease_expires_at: new Date(Date.now() + 60_000),
      }),
    ).resolves.toBe(true);
    await expect(
      store.beginStateObservation({ ...base, lease_id: 'same-generation-lease', invalidate_receipt: false }),
    ).resolves.toBe(true);
    await expect(
      store.observeState({
        ...base,
        lease_id: 'same-generation-lease',
        before_state_sha256: 'before',
        after_state_sha256: 'after',
      }),
    ).resolves.toBe(1);
  });

  it('invalidates a receipt when an expired lease is taken over with observation pending', async () => {
    const first = getStore();
    const second = getStore();
    const repository = await first.createRepository(repositoryInput(OWNER_A, 'workspace-pending-takeover'));
    const base = { repository_id: repository.id, workspace_cwd: 'C:/work/workspace-pending-takeover' };
    const result = await durableResult('pending-takeover');
    await expect(
      first.acquireLease({
        ...base,
        owner_id: 'replica-a',
        lease_id: 'pending-lease',
        lease_expires_at: new Date(Date.now() + 250),
      }),
    ).resolves.toEqual({ mutation_epoch: 0 });
    await expect(
      first.activateReceipt({
        ...base,
        lease_id: 'pending-lease',
        mutation_epoch: 0,
        state_sha256: 'state-a',
        command: 'pnpm verify',
        created_at: new Date(),
        ...result,
      }),
    ).resolves.toBe(true);
    await expect(
      first.beginStateObservation({ ...base, lease_id: 'pending-lease', invalidate_receipt: false }),
    ).resolves.toBe(true);
    await new Promise<void>(resolve => setTimeout(resolve, 300));

    await expect(
      second.acquireLease({
        ...base,
        owner_id: 'replica-b',
        lease_id: 'takeover-lease',
        lease_expires_at: new Date(Date.now() + 60_000),
      }),
    ).resolves.toEqual({ mutation_epoch: 1 });
    await expect(
      second.consumeReceipt({
        ...base,
        lease_id: 'takeover-lease',
        mutation_epoch: 1,
        state_sha256: 'state-a',
      }),
    ).resolves.toBe(false);
  });
}
