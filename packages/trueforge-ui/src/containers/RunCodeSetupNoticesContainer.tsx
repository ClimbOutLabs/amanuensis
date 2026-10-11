'use client';

import { useMemo } from 'react';

import { RunCodeSetupNotice } from '../atoms/RunCodeSetupNotice.js';
import { collectRunCodeSetupFailures, type MessagePart } from '../utils/runCodeSetupFailure.js';

/**
 * Shows why a turn's run_code calls did not run when the sandbox could not start. Derived from the
 * persisted tool results, so it is there after a reload. It renders outside the agent-details
 * disclosure: the user needs the reason, with any install link, even while the details stay collapsed.
 */
export function RunCodeSetupNoticesContainer({ parts }: { parts: readonly MessagePart[] }) {
  const failures = useMemo(() => collectRunCodeSetupFailures(parts), [parts]);
  return (
    <>
      {failures.map(failure => (
        <RunCodeSetupNotice key={failure.error} message={failure.error} />
      ))}
    </>
  );
}
