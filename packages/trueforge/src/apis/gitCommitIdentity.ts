import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Logger } from 'winston';

import type { ResolveRequestContext } from '../auth/identity';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import { getGitCommitIdentityRoute, putGitCommitIdentityRoute } from '../routes/gitCommitIdentityRoutes';
import {
  defaultGitCommitIdentity,
  GIT_COMMIT_IDENTITY_SETTING_KEY,
  readStoredGitCommitIdentity,
  type StoredGitCommitIdentity,
} from '../runtime/gitCommitIdentitySettings';
import type { GitCommitIdentitySetting } from '../schemas/gitCommitIdentity';
import { TENANT_ID } from './sessions';

export interface GitCommitIdentityRouterDeps<TTransaction> {
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  personalizationStore: Pick<IPersonalizationStore<TTransaction>, 'getProfile'>;
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
}

/** Settings surface for the name on Git commits (mounted at /api/v1/settings/git-commit-identity). */
export function createGitCommitIdentityRouter<TTransaction>(deps: GitCommitIdentityRouterDeps<TTransaction>) {
  const router = new OpenAPIHono();

  const withDefaults = async (c: Context, stored: StoredGitCommitIdentity): Promise<GitCommitIdentitySetting> => {
    const profile = await deps.personalizationStore.getProfile({
      tenant_id: TENANT_ID,
      created_by: deps.resolveRequestContext(c).subject.id,
    });
    const fallback = defaultGitCommitIdentity({ personName: profile?.user_name });
    return { ...stored, default_name: fallback.name, default_email: fallback.email };
  };

  const getHandler: RouteHandler<typeof getGitCommitIdentityRoute> = async c => {
    const stored = await readStoredGitCommitIdentity({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    });
    return c.json({ data: await withDefaults(c, stored) }, 200);
  };

  const putHandler: RouteHandler<typeof putGitCommitIdentityRoute> = async c => {
    const body = c.req.valid('json');
    if (body.name === null && body.email === null) {
      await deps.globalSettingsStore.deleteSetting({ key: GIT_COMMIT_IDENTITY_SETTING_KEY });
    } else {
      await deps.globalSettingsStore.setSetting({
        key: GIT_COMMIT_IDENTITY_SETTING_KEY,
        value: JSON.stringify({ name: body.name, email: body.email }),
      });
    }
    // Echo what was written: a re-read could fail and report a state that was never stored.
    return c.json({ data: await withDefaults(c, { name: body.name, email: body.email }) }, 200);
  };

  router.openapi(getGitCommitIdentityRoute, getHandler);
  router.openapi(putGitCommitIdentityRoute, putHandler);
  return router;
}
