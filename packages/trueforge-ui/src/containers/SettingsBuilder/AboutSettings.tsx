'use client';

import { useAssistantDisplayName } from '@/components/PersonalizationContext.js';
import { readBuildIdentity } from '@/plugins/trueforge-agent-server-adapter/lists.js';
import { useServerCapabilities } from '@/server/ServerContext.js';

// Source references are shown the way the rest of the UI shows them: the first
// 8 characters, with the full value kept on the row's title for anyone who needs it.
const SHORT_REF_LENGTH = 8;

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
        {version !== null ? (
          <dl className="divide-y divide-border text-sm">
            <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <dt className="shrink-0 text-text-secondary">Version</dt>
              <dd className="min-w-0 text-text-primary sm:text-right">{version}</dd>
            </div>
            {ref !== null ? (
              <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                <dt className="shrink-0 text-text-secondary">Build</dt>
                <dd className="min-w-0 text-text-primary sm:text-right" title={ref}>
                  {ref.slice(0, SHORT_REF_LENGTH)}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="text-sm text-text-secondary">Version not available.</p>
        )}
      </div>
    </div>
  );
};

export default AboutSettings;
