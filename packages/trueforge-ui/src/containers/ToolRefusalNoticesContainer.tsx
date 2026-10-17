'use client';

import { useMemo } from 'react';

import type { MessagePart } from '../utils/runCodeSetupFailure.js';
import { parseToolRefusalNotice } from '../utils/toolCallParsing.js';

/** Refusal lines for calls in these parts, sub-agent threads included, in call order, each said once. */
function collectRefusalNotices(parts: readonly MessagePart[]): string[] {
  const notices = new Set<string>();
  const visit = (current: readonly MessagePart[]): void => {
    for (const part of current) {
      if (part.type !== 'tool-call') {
        continue;
      }
      const notice = parseToolRefusalNotice(part.result);
      if (notice !== undefined) {
        notices.add(notice);
      }
      for (const message of part.messages ?? []) {
        visit(message.content);
      }
    }
  };
  visit(parts);
  return [...notices];
}

/**
 * Tells the owner, in the host's own words, why a send was refused. It renders outside the agent-details
 * disclosure: the owner needs to know nothing was sent even while the details stay collapsed.
 */
export function ToolRefusalNoticesContainer({ parts }: { parts: readonly MessagePart[] }) {
  const notices = useMemo(() => collectRefusalNotices(parts), [parts]);
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
