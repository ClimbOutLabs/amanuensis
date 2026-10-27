'use client';

import { useAssistantDisplayName } from '@/components/PersonalizationContext.js';
import { readBuildIdentity } from '@/plugins/trueforge-agent-server-adapter/lists.js';
import { useServerCapabilities } from '@/server/ServerContext.js';

const AboutSettings = () => {
  const assistantName = useAssistantDisplayName();
  const build = readBuildIdentity(useServerCapabilities());
  const version = build?.version ?? null;
  const ref = build?.ref ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-text-primary">About</h2>
        <p className="mt-1 text-sm text-text-secondary">The version of {assistantName} running on this computer.</p>
      </div>

      <div className="rounded-lg border border-border bg-card-bg p-4">
        <h3 className="text-sm font-medium text-text-primary">Version</h3>
        {version !== null ? (
          <>
            <p className="mt-2 text-2xl font-semibold text-text-primary">{version}</p>
            {ref !== null ? <p className="mt-1 text-xs text-text-secondary">{ref}</p> : null}
          </>
        ) : (
          <p className="mt-2 text-sm text-text-secondary">Version not available.</p>
        )}
      </div>
    </div>
  );
};

export default AboutSettings;
