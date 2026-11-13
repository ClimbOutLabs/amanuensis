import { z } from 'zod';

import { getErrorMessage } from '../../../utils/getErrorMessage.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

const GitCommitIdentitySettingSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  default_name: z.string(),
  default_email: z.string(),
});

/** The name and email on Git commits made in the sandbox. A null part means the default beside it is used. */
export type GitCommitIdentitySetting = z.infer<typeof GitCommitIdentitySettingSchema>;

export type GitCommitIdentityChoice = Pick<GitCommitIdentitySetting, 'name' | 'email'>;

export interface GitCommitIdentityCatalog {
  getGitCommitIdentity(): Promise<GitCommitIdentitySetting>;
  /** Stores the choice; a null part goes back to its default. */
  setGitCommitIdentity(choice: GitCommitIdentityChoice): Promise<GitCommitIdentitySetting>;
}

const ResponseSchema = z.object({ data: GitCommitIdentitySettingSchema });

/**
 * Calls GET/PUT /api/v1/settings/git-commit-identity with the same base URL, token, and fetch the SDK
 * client was built from. Direct because the generated SDK does not carry this route yet.
 */
export function createGitCommitIdentityCatalog(options: CreateTrueForgeClientOptions = {}): GitCommitIdentityCatalog {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request(method: 'GET' | 'PUT', body?: GitCommitIdentityChoice): Promise<GitCommitIdentitySetting> {
    const response = await fetchImpl(`${base}/api/v1/settings/git-commit-identity`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseBody: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      if (response.status === 400) {
        throw new Error(
          'That name or email cannot be used. Use a name without < or >, and an email like you@example.com.',
        );
      }
      const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(responseBody);
      throw new Error(
        failure.success
          ? failure.data.error.message
          : `The commit name failed with HTTP ${String(response.status)}. Try again in a moment.`,
      );
    }
    const parsed = ResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new Error('The server sent back something unexpected for the commit name. Reload the page and try again.');
    }
    return parsed.data.data;
  }

  return {
    getGitCommitIdentity: () => request('GET'),
    setGitCommitIdentity: choice => request('PUT', { name: choice.name, email: choice.email }),
  };
}

/** Plain-words error for the commit name; callers render it inline. */
export function gitCommitIdentityErrorMessage(error: unknown): string {
  return getErrorMessage(error, 'The commit name could not be saved. Try again in a moment.');
}
