'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  gitCommitIdentityErrorMessage,
  type GitCommitIdentityCatalog,
  type GitCommitIdentityChoice,
  type GitCommitIdentitySetting,
} from '../../plugins/trueforge-agent-server-adapter/catalogs/gitCommitIdentityCatalog.js';
import { useOptionalServer } from '../../server/ServerContext.js';

/** Read-only shape probe: other servers carry no `gitCommitIdentity` port and report "not supported". */
function hasGitCommitIdentityPort(server: object): server is { gitCommitIdentity: GitCommitIdentityCatalog } {
  const port: unknown = Reflect.get(server, 'gitCommitIdentity');
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof Reflect.get(port, 'getGitCommitIdentity') === 'function' &&
    typeof Reflect.get(port, 'setGitCommitIdentity') === 'function'
  );
}

export interface GitCommitIdentitySettingState {
  supported: boolean;
  /** The stored choice with its defaults; `null` while loading or when the read failed. */
  setting: GitCommitIdentitySetting | null;
  saving: boolean;
  error: string | null;
  /** Resolves to whether the choice was stored. */
  save(choice: GitCommitIdentityChoice): Promise<boolean>;
}

/** The name and email on Git commits made in the sandbox. The server owns the choice and its defaults. */
export function useGitCommitIdentitySetting(): GitCommitIdentitySettingState {
  const server = useOptionalServer();
  const catalog = server !== null && hasGitCommitIdentityPort(server) ? server.gitCommitIdentity : null;

  const [setting, setSetting] = useState<GitCommitIdentitySetting | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (catalog === null) return;
    let cancelled = false;
    void catalog.getGitCommitIdentity().then(
      next => {
        if (!cancelled) setSetting(next);
      },
      (caught: unknown) => {
        if (!cancelled) setError(gitCommitIdentityErrorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [catalog]);

  const save = useCallback(
    async (choice: GitCommitIdentityChoice): Promise<boolean> => {
      if (catalog === null) return false;
      setSaving(true);
      setError(null);
      try {
        setSetting(await catalog.setGitCommitIdentity(choice));
        return true;
      } catch (caught) {
        setError(gitCommitIdentityErrorMessage(caught));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [catalog],
  );

  return { supported: catalog !== null, setting, saving, error, save };
}
