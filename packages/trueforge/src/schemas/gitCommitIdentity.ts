import { z } from '@hono/zod-openapi';

import { StoredGitCommitIdentitySchema } from '../runtime/gitCommitIdentitySettings';

export const GitCommitIdentitySettingSchema = z
  .object({
    name: z.string().nullable().describe('The name the person chose for commits. `null` when they chose none.'),
    email: z.string().nullable().describe('The email the person chose for commits. `null` when they chose none.'),
    default_name: z.string().describe('The name used while `name` is `null`.'),
    default_email: z.string().describe('The email used while `email` is `null`.'),
  })
  .openapi('GitCommitIdentitySetting');

export const UpdateGitCommitIdentityRequestSchema = StoredGitCommitIdentitySchema.extend({
  name: StoredGitCommitIdentitySchema.shape.name.describe(
    'Name to put on commits, up to 100 characters. `null` goes back to the default.',
  ),
  email: StoredGitCommitIdentitySchema.shape.email.describe(
    'Email to put on commits. `null` goes back to the default.',
  ),
}).openapi('UpdateGitCommitIdentityRequest', { example: { name: 'Sam Rivera', email: null } });

export const GetGitCommitIdentityResponseSchema = z
  .object({ data: GitCommitIdentitySettingSchema })
  .openapi('GetGitCommitIdentityResponse');

export type GitCommitIdentitySetting = z.infer<typeof GitCommitIdentitySettingSchema>;
