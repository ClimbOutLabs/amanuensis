import type { RepositoryCommandSource } from '@truefoundry/trueforge-core/core';
import { throwIfSignalAborted } from '@truefoundry/trueforge-core/core/util/abort';
import { createHash } from 'node:crypto';
import {
  RepositoryRevisionConflictError,
  VERIFY_COMMAND_PURPOSES,
  type IRepositoryStore,
  type VerifyCommandPurpose,
} from '../db/repositoryStore';

const MAX_PROPOSED_COMMAND_BYTES = 8_192;
const PACKAGE_MANAGERS = new Set(['bun', 'npm', 'pnpm', 'yarn']);

export interface DerivedRepositoryCommandProposal {
  id: string;
  purpose: VerifyCommandPurpose;
  command: string;
  source_kind: RepositoryCommandSource['source_kind'];
  source_path: string;
  source_fingerprint: string;
}

function proposalMatches(left: DerivedRepositoryCommandProposal, right: DerivedRepositoryCommandProposal): boolean {
  return (
    left.id === right.id &&
    left.purpose === right.purpose &&
    left.command === right.command &&
    left.source_kind === right.source_kind &&
    left.source_path === right.source_path &&
    left.source_fingerprint === right.source_fingerprint
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedCommand(value: string): string | undefined {
  const command = value.trim();
  if (command.length === 0 || Buffer.byteLength(command, 'utf8') > MAX_PROPOSED_COMMAND_BYTES) {
    return undefined;
  }
  return command;
}

function packageManagerName(value: unknown): string {
  if (typeof value !== 'string') {
    return 'npm';
  }
  const at = value.indexOf('@');
  const name = (at < 0 ? value : value.slice(0, at)).trim().toLowerCase();
  return PACKAGE_MANAGERS.has(name) ? name : 'npm';
}

function packageJsonCommands(content: string): { purpose: VerifyCommandPurpose; command: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed['scripts'])) {
    return [];
  }
  const manager = packageManagerName(parsed['packageManager']);
  const commands: { purpose: VerifyCommandPurpose; command: string }[] = [];
  for (const purpose of VERIFY_COMMAND_PURPOSES) {
    const script = parsed['scripts'][purpose];
    if (typeof script !== 'string' || script.trim().length === 0) {
      continue;
    }
    commands.push({ purpose, command: `${manager} run ${purpose}` });
  }
  return commands;
}

function agentsCommands(content: string): { purpose: VerifyCommandPurpose; command: string }[] {
  const commands: { purpose: VerifyCommandPurpose; command: string }[] = [];
  const declaration = /^\s*(?:[-*]\s*)?(build|test|verify)(?:\s+command)?\s*:\s*`([^`\r\n]+)`\s*$/gim;
  for (const match of content.matchAll(declaration)) {
    const purpose = match[1]?.toLowerCase();
    const command = match[2] === undefined ? undefined : boundedCommand(match[2]);
    if ((purpose === 'build' || purpose === 'test' || purpose === 'verify') && command !== undefined) {
      commands.push({ purpose, command });
    }
  }
  return commands;
}

function sourceCommands(source: RepositoryCommandSource): { purpose: VerifyCommandPurpose; command: string }[] {
  if (source.source_kind === 'package_json') {
    return packageJsonCommands(source.content);
  }
  return agentsCommands(source.content);
}

function proposalId(input: {
  repository_id: string;
  source_kind: RepositoryCommandSource['source_kind'];
  source_path: string;
  purpose: VerifyCommandPurpose;
  command: string;
}): string {
  const digest = createHash('sha256')
    .update(
      [input.repository_id, input.source_kind, input.source_path, input.purpose, input.command].join('\u0000'),
      'utf8',
    )
    .digest('hex');
  return `proposal-${digest}`;
}

function sourceOrder(source: RepositoryCommandSource): string {
  return `${source.source_kind === 'agents_md' ? '0' : '1'}\u0000${source.source_path}`;
}

/**
 * Derive bounded proposals from structured package scripts and explicit
 * AGENTS.md declarations. These are suggestions only and never executable.
 */
export function deriveRepositoryCommandProposals(input: {
  repository_id: string;
  sources: readonly RepositoryCommandSource[];
  confirmed_commands: readonly { command: string }[];
}): DerivedRepositoryCommandProposal[] {
  const confirmed = new Set(input.confirmed_commands.map(item => item.command.trim()));
  const seen = new Set<string>();
  const proposals: DerivedRepositoryCommandProposal[] = [];
  const sources = [...input.sources].sort((left, right) => sourceOrder(left).localeCompare(sourceOrder(right)));
  for (const source of sources) {
    for (const candidate of sourceCommands(source)) {
      const command = boundedCommand(candidate.command);
      if (command === undefined || confirmed.has(command)) {
        continue;
      }
      const key = `${candidate.purpose}\u0000${command}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      proposals.push({
        id: proposalId({
          repository_id: input.repository_id,
          source_kind: source.source_kind,
          source_path: source.source_path,
          purpose: candidate.purpose,
          command,
        }),
        purpose: candidate.purpose,
        command,
        source_kind: source.source_kind,
        source_path: source.source_path,
        source_fingerprint: source.source_fingerprint,
      });
    }
  }
  return proposals;
}

/** Synchronize only the source files observed in this checkout refresh. */
export async function synchronizeRepositoryCommandProposals(input: {
  tenant_id: string;
  created_by: string;
  repository_id: string;
  sources: readonly RepositoryCommandSource[];
  store: Pick<
    IRepositoryStore,
    'getRepository' | 'listVerifyCommands' | 'listVerifyCommandProposals' | 'replaceVerifyCommandProposals'
  >;
  signal: AbortSignal | undefined;
}): Promise<void> {
  throwIfSignalAborted(input.signal);
  const owner = {
    tenant_id: input.tenant_id,
    created_by: input.created_by,
    repository_id: input.repository_id,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const repository = await input.store.getRepository(owner);
    if (repository === undefined) {
      return;
    }
    const [confirmed, existing] = await Promise.all([
      input.store.listVerifyCommands(owner),
      input.store.listVerifyCommandProposals(owner),
    ]);
    throwIfSignalAborted(input.signal);
    const desired = deriveRepositoryCommandProposals({
      repository_id: input.repository_id,
      sources: input.sources,
      confirmed_commands: confirmed,
    });
    const observed = new Set(input.sources.map(source => `${source.source_kind}\u0000${source.source_path}`));
    const relevantExisting = (
      observed.size === 0
        ? existing
        : existing.filter(proposal => observed.has(`${proposal.source_kind}\u0000${proposal.source_path}`))
    ).sort((left, right) => left.id.localeCompare(right.id));
    const sortedDesired = [...desired].sort((left, right) => left.id.localeCompare(right.id));
    if (
      relevantExisting.length === sortedDesired.length &&
      relevantExisting.every((proposal, index) => {
        const candidate = sortedDesired[index];
        return candidate !== undefined && proposalMatches(proposal, candidate);
      })
    ) {
      return;
    }
    try {
      await input.store.replaceVerifyCommandProposals({
        ...owner,
        expected_revision: repository.revision,
        observed_sources: input.sources.map(source => ({
          source_kind: source.source_kind,
          source_path: source.source_path,
        })),
        proposals: desired,
      });
      throwIfSignalAborted(input.signal);
      return;
    } catch (error) {
      if (!(error instanceof RepositoryRevisionConflictError) || attempt === 1) {
        throw error;
      }
    }
  }
}
