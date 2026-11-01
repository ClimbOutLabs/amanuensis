import { toolResultResponse } from '@truefoundry/trueforge-core/core';
import type { z } from 'zod';

export function jsonResult(value: unknown) {
  return toolResultResponse({ text: JSON.stringify(value) });
}

export function errorResult(message: string) {
  return toolResultResponse({ text: JSON.stringify({ error: message }), isError: true });
}

/** Each problem with the call, by field, in one line. */
export function plainIssues(error: z.ZodError): string {
  const issues = error.issues.map(issue =>
    issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
  );
  return `These details were not valid: ${issues.join('; ')}.`;
}
