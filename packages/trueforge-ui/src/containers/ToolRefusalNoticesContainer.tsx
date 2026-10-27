'use client';

/**
 * Tells the person, in the host's own words, what was not done. It renders where the step happened and
 * outside the agent-details disclosure: the person needs to know even while the details stay collapsed.
 */
export function ToolRefusalNoticesContainer({ notices }: { notices: readonly string[] }) {
  return (
    <>
      {notices.map(notice => (
        <p key={notice} role="status" data-testid="tool-refusal-notice" className="mt-2 text-sm text-text-primary">
          {notice}
        </p>
      ))}
    </>
  );
}
