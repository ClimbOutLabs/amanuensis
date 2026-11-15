import {
  DEFAULT_GIT_COMMIT_IDENTITY,
  extractErrorLogFields,
  GitCommitIdentitySchema,
  type GitCommitIdentity,
} from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';
import { z } from 'zod';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';

/** Global-settings key for the name and email the person chose for commits. Each part may be unset. */
export const GIT_COMMIT_IDENTITY_SETTING_KEY = 'sandbox_git_commit_identity';

export const StoredGitCommitIdentitySchema = z.object({
  name: GitCommitIdentitySchema.shape.name.nullable(),
  email: GitCommitIdentitySchema.shape.email.nullable(),
});

export type StoredGitCommitIdentity = z.infer<typeof StoredGitCommitIdentitySchema>;

const NOTHING_CHOSEN: StoredGitCommitIdentity = { name: null, email: null };

/** What the person chose. A failed or malformed read gives nothing chosen, so commits still get the defaults. */
export async function readStoredGitCommitIdentity(deps: {
  globalSettingsStore: Pick<IGlobalSettingsStore, 'getSetting'>;
  logger: Logger;
}): Promise<StoredGitCommitIdentity> {
  let record;
  try {
    record = await deps.globalSettingsStore.getSetting({ key: GIT_COMMIT_IDENTITY_SETTING_KEY });
  } catch (error) {
    deps.logger.warn('Global setting read failed; commits use the default name', extractErrorLogFields(error));
    return NOTHING_CHOSEN;
  }
  if (record === undefined) {
    return NOTHING_CHOSEN;
  }
  let json: unknown;
  try {
    json = JSON.parse(record.value);
  } catch {
    json = undefined;
  }
  const parsed = StoredGitCommitIdentitySchema.safeParse(json);
  if (!parsed.success) {
    deps.logger.warn('Ignoring malformed commit name setting; commits use the default name');
    return NOTHING_CHOSEN;
  }
  return parsed.data;
}

/** The name and email used when the person chose none: their own name from Personalization when it is usable. */
export function defaultGitCommitIdentity(input: { personName: string | null | undefined }): GitCommitIdentity {
  const name = GitCommitIdentitySchema.shape.name.safeParse(input.personName ?? '');
  return {
    name: name.success ? name.data : DEFAULT_GIT_COMMIT_IDENTITY.name,
    email: DEFAULT_GIT_COMMIT_IDENTITY.email,
  };
}

/** The name and email commits carry: the person's choice, then their own name, then the built-in default. */
export function effectiveGitCommitIdentity(input: {
  stored: StoredGitCommitIdentity;
  personName: string | null | undefined;
}): GitCommitIdentity {
  const fallback = defaultGitCommitIdentity({ personName: input.personName });
  return { name: input.stored.name ?? fallback.name, email: input.stored.email ?? fallback.email };
}
